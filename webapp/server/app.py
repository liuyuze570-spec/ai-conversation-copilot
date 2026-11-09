"""最小 FastAPI 服务：翻译 / 识别 / 回复 / 健康检查。

定位：给网页版提供一个**不把 Key 放到浏览器**的薄后端。它不重写桌面端的音频采集，
只做三件事：调模型、限流计数、把「真实/预置」如实报给前端。

安全口径（都是可核验的约束，不是口号）：
- 上游地址只从环境变量读，前端传什么都不会改变目标地址；
- 输入文本、音频、模型输出一律当不可信数据，日志里只留长度、模式、耗时、错误码；
- 会话用 HttpOnly Cookie（SameSite=Lax），匿名配额按会话计数，另有按 IP 的速率限制；
- 音频按字节上限读入，超限直接拒绝，不写磁盘以外的任何地方，临时文件用完即删；
- CORS 默认不开；要跨域必须在 COPILOT_ALLOW_ORIGINS 里显式列出来。
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

from engine_asr import ASRError, build_asr_chain, choose_asr, probe_seconds
from engine_mt import MTResult, UpstreamError, build_mt_chain, choose_mt
from engine_mt_multi import build_cascade, supported_codes
from engine_mt_onnx import OnnxOpusMT
from engine_reply import ReplyError, build_reply_chain, choose_reply
from phrasebook import drop_repeated_tail, looks_degenerate
from phrasebook import lookup as phrase_lookup

VERSION = "0.7.0-web.5"  # 网页版独立版本号，与桌面 App 的 0.6.2 不是一个东西
BUILD_ID = os.getenv("COPILOT_BUILD_ID", "web5-2026-11-09")
# 每个进程一个短 ID：用来判「请求是不是被不同实例/重启后的进程接走的」。
# 不含任何用户数据，可以安全地出现在 /api/health 里。
BOOT_ID = secrets.token_hex(4)
BOOT_AT = time.time()
MAX_CHARS = int(os.getenv("COPILOT_MAX_CHARS", "2000"))
MAX_AUDIO_MB = float(os.getenv("COPILOT_MAX_AUDIO_MB", "8"))
MAX_AUDIO_SECONDS = int(os.getenv("COPILOT_MAX_AUDIO_SECONDS", "60"))
QUOTA_TRANSLATE = int(os.getenv("COPILOT_QUOTA_TRANSLATE", "40"))
QUOTA_TRANSCRIBE = int(os.getenv("COPILOT_QUOTA_TRANSCRIBE", "10"))
# 回复配额与翻译同额：翻译完成后会自动生成一轮回复建议，
# 若只给 15 次，用户翻到一半就没有回复建议了 —— 那是核心功能，不是附加项。
QUOTA_REPLY = int(os.getenv("COPILOT_QUOTA_REPLY", "40"))
SESSION_TTL = int(os.getenv("COPILOT_SESSION_TTL", "7200"))
RATE_PER_MIN = int(os.getenv("COPILOT_RATE_PER_MIN", "30"))
REAL_DISABLED = os.getenv("COPILOT_REAL_DISABLED") == "1"

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
LOG = logging.getLogger("copilot")

app = FastAPI(title="AI Conversation Copilot Web API", version=VERSION, docs_url=None, redoc_url=None)

_origins = [item.strip() for item in (os.getenv("COPILOT_ALLOW_ORIGINS") or "").split(",") if item.strip()]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST"],
        allow_headers=["content-type", "x-session-id"],
    )


# --------------------------------------------------------------------------- #
# 会话 / 配额 / 限流（全部在内存里，重启即清 —— 不落盘就不存在"忘了删"）
# --------------------------------------------------------------------------- #


@dataclass
class Session:
    sid: str
    created: float
    translate_left: int
    transcribe_left: int
    reply_left: int


@dataclass
class Bucket:
    hits: deque[float] = field(default_factory=deque)


class Store:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sessions: dict[str, Session] = {}
        self.by_ip: dict[str, Bucket] = defaultdict(Bucket)
        self.counters = {"translate": 0, "transcribe": 0, "reply": 0, "rejected": 0}

    def new_session(self) -> Session:
        with self.lock:
            sid = secrets.token_urlsafe(18)
            session = Session(sid, time.time(), QUOTA_TRANSLATE, QUOTA_TRANSCRIBE, QUOTA_REPLY)
            self.sessions[sid] = session
            return session

    def lookup(self, sid: str | None) -> tuple[Session | None, str]:
        """返回 (会话, 原因)。原因只用于排查，不含 sid。

        - `missing`：浏览器压根没带会话标识（Cookie 被丢、跨站、请求头没带上）；
        - `unknown`：带了，但本进程没有这条会话（进程重启 / 请求被别的实例接走）；
        - `expired`：带了，但超过 SESSION_TTL。

        这三种在旧实现里都压成一句「会话已过期」，排查时看不出到底是哪一种。
        """
        if not sid:
            return None, "missing"
        with self.lock:
            session = self.sessions.get(sid)
            if not session:
                return None, "unknown"
            if time.time() - session.created > SESSION_TTL:
                self.sessions.pop(sid, None)
                return None, "expired"
            return session, ""

    def get(self, sid: str | None) -> Session | None:
        return self.lookup(sid)[0]

    def spend(self, session: Session, kind: str) -> bool:
        with self.lock:
            # 三类各自记额度。旧实现在 else 里一律扣识别额度，
            # 于是调用 reply 会悄悄吃掉识别次数。
            if kind == "translate":
                if session.translate_left <= 0:
                    return False
                session.translate_left -= 1
            elif kind == "transcribe":
                if session.transcribe_left <= 0:
                    return False
                session.transcribe_left -= 1
            elif kind == "reply":
                if session.reply_left <= 0:
                    return False
                session.reply_left -= 1
            else:
                return False
            return True

    def rate_ok(self, ip: str) -> bool:
        now = time.time()
        with self.lock:
            bucket = self.by_ip[ip]
            while bucket.hits and now - bucket.hits[0] > 60:
                bucket.hits.popleft()
            if len(bucket.hits) >= RATE_PER_MIN:
                return False
            bucket.hits.append(now)
            return True

    def bump(self, key: str) -> None:
        with self.lock:
            self.counters[key] += 1


STORE = Store()

# 「配置好了」不等于「真的能用」。这里只记真实调用发生过什么：
# ok 过一次才算 verified；失败只留错误码，不留正文。
RUNTIME: dict[str, dict[str, object]] = {
    "translate": {"ok": 0, "fail": 0, "last_error": ""},
    "transcribe": {"ok": 0, "fail": 0, "last_error": ""},
    "reply": {"ok": 0, "fail": 0, "last_error": ""},
}
RUNTIME_LOCK = threading.Lock()


def mark_runtime(kind: str, error_code: str | None = None) -> None:
    with RUNTIME_LOCK:
        slot = RUNTIME[kind]
        if error_code:
            slot["fail"] = int(slot["fail"]) + 1
            slot["last_error"] = error_code
        else:
            slot["ok"] = int(slot["ok"]) + 1
MT_CHAIN: list[object] = []
MT_DETAIL: dict[str, str] = {}
#: 多语言（日/韩/俄）→ 英 → 中 的级联链，按语言代码索引。
#: 只装本机真的有模型的那几种；`/api/health` 如实报告，不假装支持。
MT_CASCADE: dict[str, object] = {}
ASR_CHAIN: list[object] = []
ASR_DETAIL: dict[str, str] = {}
REPLY_CHAIN: list[object] = []
REPLY_DETAIL: dict[str, str] = {}

SUPPORTED_SOURCE = {"en": "英语", "ja": "日语", "ko": "韩语", "ru": "俄语"}


@app.on_event("startup")
def startup() -> None:
    global MT_CHAIN, MT_DETAIL, ASR_CHAIN, ASR_DETAIL, REPLY_CHAIN, REPLY_DETAIL
    MT_CHAIN, MT_DETAIL = build_mt_chain()
    ASR_CHAIN, ASR_DETAIL = build_asr_chain()
    REPLY_CHAIN, REPLY_DETAIL = build_reply_chain()
    LOG.info("mt=%s", json.dumps(MT_DETAIL, ensure_ascii=False))
    LOG.info("asr=%s", json.dumps(ASR_DETAIL, ensure_ascii=False))
    for backend in MT_CHAIN + ASR_CHAIN:
        detail = getattr(backend, "detail", "")
        if detail:
            LOG.info("backend %s -> %s", getattr(backend, "mode", "?"), detail)
    # 本地模型首次加载要几百毫秒，放在启动阶段预热，别让第一个用户等
    chosen = choose_mt(MT_CHAIN)
    warmup = getattr(chosen, "warmup", None)
    if callable(warmup):
        try:
            LOG.info("mt warmup %s", json.dumps(warmup(), ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001 - 预热失败不影响启动，下次请求再试
            LOG.warning("mt warmup failed: %s", type(exc).__name__)
    _build_cascades(chosen)


def _build_cascades(zh_engine: object | None) -> None:
    """把本机装了的日/韩/俄模型接成级联。没有模型就不建，不占内存也不用假的顶上。"""
    if not isinstance(zh_engine, OnnxOpusMT):
        LOG.info("cascade=skipped (no local en→zh engine)")
        return
    for code in supported_codes():
        try:
            MT_CASCADE[code] = build_cascade(code, zh_engine)
            LOG.info("cascade %s -> %s", code, MT_CASCADE[code].detail)  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001 - 单个语种坏了不影响其它
            LOG.warning("cascade %s failed: %s", code, type(exc).__name__)
    if MT_CASCADE:
        LOG.info("cascade ready: %s", ",".join(sorted(MT_CASCADE)))


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = uuid.uuid4().hex[:16]
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        response.headers["cache-control"] = "no-store"
        if request.url.path.startswith("/api/"):
            LOG.info(
                "req id=%s path=%s status=%s ms=%d",
                request_id,
                request.url.path,
                response.status_code,
                int((time.perf_counter() - started) * 1000),
            )
        return response


app.add_middleware(RequestIdMiddleware)


def error(request: Request, code: str, status: int, message: str) -> JSONResponse:
    STORE.bump("rejected")
    return JSONResponse(
        {"error": {"code": code, "message": message}, "request_id": getattr(request.state, "request_id", None)},
        status_code=status,
    )


def backend_or_none(chain: list[object]) -> object | None:
    """选当前该用哪一路。

    总开关 `COPILOT_REAL_DISABLED=1` 必须**在这里**生效：之前只在 `/api/health`
    里把模式写成 mock，接口却照样调真实模型 —— 界面说「只返回预置」，实际还在
    跑模型，这种不一致比没有开关更糟。现在强制只留 mock 那一路：
    - 翻译：预置命中的返回预置，未命中返回 NO_PRESET
    - 识别：链里那个 mock 是永远报错的占位，会明确回 NOT_CONFIGURED
    - 回复：模板句，标 mock
    """
    if REAL_DISABLED:
        for item in chain:
            if getattr(item, "mode", "") == "mock":
                return item
        return None
    for item in chain:
        if getattr(item, "available", False):
            return item
    return None


def translate_with_chain(text: str) -> tuple[MTResult | None, list[str], UpstreamError | None]:
    """按链逐路翻译，**跳过退化输出**。

    以前只取第一个可用后端，拿到什么就返回什么。实测本地模型在极短输入上会
    退化成 `哈哈哈哈哈哈哈哈哈`、`hi hi hi`，而界面把它当「翻译完成」展示 ——
    对听障使用者来说，这比明确失败更危险：他会以为对方就是这么说的。

    现在：这一路退化就记一笔原因，继续试下一路；全都不行才报错。
    返回的 `failures` 只含「模式 + 错误码」，不含任何正文。
    """
    failures: list[str] = []
    last_error: UpstreamError | None = None
    for backend in MT_CHAIN:
        mode = getattr(backend, "mode", "?")
        if REAL_DISABLED and mode != "mock":
            continue
        if not getattr(backend, "available", False):
            continue
        try:
            result = backend.translate(text)  # type: ignore[attr-defined]
        except UpstreamError as failure:
            failures.append(f"{mode}:{failure.code}")
            last_error = failure
            continue
        bad, why = looks_degenerate(text, result.translation)
        if bad:
            failures.append(f"{mode}:{why}")
            continue
        return result, failures, None
    return None, failures, last_error


def translate_cascade(
    code: str, text: str
) -> tuple[MTResult | None, list[str], UpstreamError | None]:
    """日/韩/俄：源语言 → 英语 → 中文。模型没装就明确说没装。

    退化判据对非拉丁源语言要放宽：`looks_degenerate` 的「原样吐回」和「长度失控」
    两条是按英文单词数算的，日语/韩语没有空格，套上去会误判成退化。
    """
    cascade = MT_CASCADE.get(code)
    if cascade is None:
        return None, [], UpstreamError("LANGUAGE_NOT_READY", 503)
    try:
        result = cascade.translate(text)  # type: ignore[attr-defined]
    except UpstreamError as failure:
        return None, [f"{code}:{failure.code}"], failure
    bad, why = looks_degenerate(text, result.translation, latin_source=False)
    if bad:
        return None, [f"{code}:{why}"], None
    result.via = getattr(cascade, "last_via", None)  # type: ignore[attr-defined]
    return result, [], None


SESSION_HEADER = "x-session-id"


def session_id_from(request: Request) -> str | None:
    """会话标识的两个来源：HttpOnly Cookie（主）与 `X-Session-Id` 请求头（备）。

    为什么要有第二种：生产环境在反向代理后面，Cookie 的任何一环（域、路径、
    网关改写、浏览器隐私设置）出问题，都会表现成「刚建的会话就用不了」。
    请求头由页面自己带，不依赖 Cookie 策略，能把这类故障排除掉。
    两种都校验同一个服务端会话表，没有放宽鉴权。
    """
    cookie = request.cookies.get("sid")
    if cookie:
        return cookie
    header = request.headers.get(SESSION_HEADER)
    if header:
        value = header.strip()
        return value or None
    return None


def require_session(request: Request) -> Session | JSONResponse:
    session, reason = STORE.lookup(session_id_from(request))
    if session is None:
        STORE.bump("rejected")
        return JSONResponse(
            {
                "error": {
                    "code": "SESSION_REQUIRED",
                    # 这条消息要能让前端判断「可以安全重建一次再试」：
                    # 会话检查在扣配额和跑模型之前，所以重建重试不会重复计费。
                    "message": "匿名会话不存在或已过期，正在重新建立",
                    "reason": reason,
                    "recoverable": True,
                },
                "request_id": getattr(request.state, "request_id", None),
            },
            status_code=403,
        )
    return session


def mode_state() -> tuple[dict[str, str], dict[str, bool], list[str]]:
    notes: list[str] = []
    if REAL_DISABLED:
        notes.append("运营方已关闭真实模型调用（COPILOT_REAL_DISABLED=1），只返回预置结果")
        return (
            {"translate": "mock", "transcribe": "mock", "reply": "mock"},
            {"translate": False, "transcribe": False, "reply": False},
            notes,
        )
    mt = choose_mt(MT_CHAIN)
    asr = choose_asr(ASR_CHAIN)
    reply = choose_reply(REPLY_CHAIN)
    mode = {
        "translate": getattr(mt, "mode", "mock"),
        "transcribe": getattr(asr, "mode", "mock"),
        "reply": getattr(reply, "mode", "mock"),
    }
    real = {
        "translate": mode["translate"] != "mock",
        "transcribe": mode["transcribe"] != "mock",
        "reply": mode["reply"] != "mock",
    }
    for name, detail in (("translate", MT_DETAIL), ("transcribe", ASR_DETAIL), ("reply", REPLY_DETAIL)):
        if not real[name]:
            notes.append(f"{name}: " + "; ".join(f"{key}={value}" for key, value in detail.items() if value))
    return mode, real, notes


@app.get("/api/health")
def health() -> dict:
    mode, real, notes = mode_state()
    return {
        "ok": True,
        "version": VERSION,
        "build": BUILD_ID,
        "mode": mode,
        "real": real,
        "limits": {
            "max_chars": MAX_CHARS,
            "max_audio_mb": MAX_AUDIO_MB,
            "max_audio_seconds": MAX_AUDIO_SECONDS,
            "quota_translate": QUOTA_TRANSLATE,
            "quota_transcribe": QUOTA_TRANSCRIBE,
            "quota_reply": QUOTA_REPLY,
        },
        # 只为排查「会话为什么丢」：进程标识、运行时长、在线会话数。
        # 不含 sid、密钥、任何正文。
        "diag": {
            "boot": BOOT_ID,
            "uptime_s": int(time.time() - BOOT_AT),
            "sessions": len(STORE.sessions),
            "session_ttl": SESSION_TTL,
            "session_transport": ["cookie", "header"],
        },
        # `real` 只说明「配了真实后端」；`verified` 才是「这一路真的成功返回过」。
        # 配了一个错 Key 时 real 仍是 true，所以两者必须分开看。
        "verified": {kind: int(slot["ok"]) > 0 for kind, slot in RUNTIME.items()},
        "runtime": RUNTIME,
        # 翻译语言支持：英语是直译，日/韩/俄是「→英→中」两级。
        # 界面据此禁用没装好模型的语种，而不是让用户点了才发现不行。
        "languages": {
            "source": {
                "en": {"ready": True, "pipeline": "en-zh", "label": "英语"},
                **{
                    code: {
                        "ready": code in MT_CASCADE,
                        "pipeline": f"{code}-en-zh" if code in MT_CASCADE else None,
                        "label": SUPPORTED_SOURCE[code],
                    }
                    for code in ("ja", "ko", "ru")
                },
            },
            "target": ["zh"],
        },
        "notes": notes,
    }


@app.post("/api/session")
def new_session(request: Request) -> JSONResponse:
    if not STORE.rate_ok(request.client.host if request.client else "unknown"):
        return error(request, "RATE_LIMITED", 429, "请求太频繁")
    session = STORE.new_session()
    response = JSONResponse(
        {
            # 短号只用于界面/日志对照，不能拿来当凭据
            "session_id": session.sid[:8],
            # 完整 token：让页面可以用请求头带会话，不依赖 Cookie 是否被代理丢掉。
            # 它只是匿名配额凭据，不含任何个人信息；后端两种来源都查同一张会话表。
            "token": session.sid,
            "ttl_seconds": SESSION_TTL,
            "quota": {
                "translate": QUOTA_TRANSLATE,
                "transcribe": QUOTA_TRANSCRIBE,
                "reply": QUOTA_REPLY,
            },
        }
    )
    response.set_cookie(
        "sid",
        session.sid,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )
    response.headers["x-request-id"] = getattr(request.state, "request_id", "")
    return response


class TranslateBody(BaseModel):
    text: str = Field(min_length=1)
    source_language: str = "en"
    target_language: str = "zh"


@app.post("/api/translate")
def translate(request: Request, body: TranslateBody) -> JSONResponse:
    session = require_session(request)
    if isinstance(session, JSONResponse):
        return session
    if not STORE.rate_ok(request.client.host if request.client else "unknown"):
        return error(request, "RATE_LIMITED", 429, "请求太频繁")
    text = body.text.strip()
    if not text:
        return error(request, "BAD_REQUEST", 400, "文本为空")
    if len(text) > MAX_CHARS:
        return error(request, "TOO_LARGE", 413, f"文本超过 {MAX_CHARS} 字")
    src = (body.source_language or "en").lower()
    if src not in SUPPORTED_SOURCE:
        return error(request, "BAD_REQUEST", 400, f"不支持的语言：{src}（支持 英/日/韩/俄）")
    if body.target_language != "zh":
        return error(request, "BAD_REQUEST", 400, "这版只翻成中文")

    if not STORE.spend(session, "translate"):
        return error(request, "QUOTA_EXCEEDED", 429, "本次会话的翻译次数用完了")

    # 第一路：常用语与术语库。每种源语言查自己的那张表 —— 英文 391 句、
    # 日/韩/俄各 30 来句问候。拿英文表去匹配日语原文只会误命中。
    hit = phrase_lookup(text, src)
    if hit is not None:
        mark_runtime("translate")
        STORE.bump("translate")
        LOG.info(
            "translate id=%s lang=%s mode=phrasebook kind=%s chars=%d",
            request.state.request_id,
            src,
            hit.kind,
            len(text),
        )
        return JSONResponse(
            {
                "request_id": request.state.request_id,
                "translation": hit.translation,
                "mode": "phrasebook",
                "note": hit.kind,
                "corrected": hit.corrected,
                # 命中的归一化写法（hellow → hello）。是用户自己输入内容的规范化，
                # 不含任何服务端信息，可以直接回显给界面说明「按哪个词查的」。
                "matched": hit.key,
                "source_language": src,
                "target_language": "zh",
                "elapsed_ms": 0,
            }
        )

    if src == "en":
        result, failures, last_error = translate_with_chain(text)
    else:
        result, failures, last_error = translate_cascade(src, text)
    if result is None:
        if last_error is not None and last_error.code == "LANGUAGE_NOT_READY":
            mark_runtime("translate", "LANGUAGE_NOT_READY")
            return error(
                request,
                "LANGUAGE_NOT_READY",
                503,
                f"{SUPPORTED_SOURCE[src]}翻译模型没有装好，这版还不能翻这一种",
            )
        if last_error is not None and last_error.code == "MODE_DISABLED":
            mark_runtime("translate", "MODE_DISABLED")
            return error(request, "NO_PRESET", 503, "演示模式下没有这句的预置译文")
        if last_error is not None and last_error.code in {"UPSTREAM_ERROR", "UPSTREAM_TIMEOUT"}:
            mark_runtime("translate", last_error.code)
            return error(request, last_error.code, last_error.status, "上游模型失败")
        # 模型能跑，但输出退化成重复/原样吐回 —— 不能当成功返回。
        mark_runtime("translate", "TRANSLATE_FAILED")
        LOG.warning("translate degenerate lang=%s routes=%s", src, ", ".join(failures) or "none")
        return error(
            request,
            "TRANSLATE_FAILED",
            422,
            "这句模型没有翻出来（输出退化），换一种说法或稍后重试",
        )
    mark_runtime("translate")
    STORE.bump("translate")
    # 模型有时会在句尾把刚说过的半句再复述一遍（"三点见,三点"、"明天见,明天"）。
    # 这是**字符级**复述，逗号两侧并不是同一个词，`no_repeat_ngram` 抓不到，
    # 只能在出来之后剪掉。判据刻意收窄，见 `phrasebook.drop_repeated_tail`。
    result.translation = drop_repeated_tail(result.translation)
    LOG.info(
        "translate id=%s lang=%s mode=%s chars=%d ms=%d routes=%s",
        request.state.request_id,
        src,
        result.mode,
        len(text),
        result.elapsed_ms,
        ", ".join(failures) or "-",
    )
    payload = {
        "request_id": request.state.request_id,
        "translation": result.translation,
        "mode": result.mode,
        "skipped": failures,
        "source_language": src,
        "target_language": "zh",
        "elapsed_ms": result.elapsed_ms,
    }
    if src != "en":
        # 中转英语要回去：两级翻译出问题时，使用者/我们能看出是哪一级坏的；
        # 对学语言的人也确实有用（能对照中间那句英语）。
        payload["pipeline"] = f"{src}-en-zh"
        payload["via"] = getattr(result, "via", None) or getattr(
            MT_CASCADE.get(src), "last_via", None
        )
    return JSONResponse(payload)


@app.post("/api/transcribe")
async def transcribe(
    request: Request,
    audio: UploadFile = File(...),
    language: str = Form("en"),
) -> JSONResponse:
    session = require_session(request)
    if isinstance(session, JSONResponse):
        return session
    if not STORE.rate_ok(request.client.host if request.client else "unknown"):
        return error(request, "RATE_LIMITED", 429, "请求太频繁")

    limit_bytes = int(MAX_AUDIO_MB * 1024 * 1024)
    data = await audio.read(limit_bytes + 1)
    if len(data) > limit_bytes:
        return error(request, "TOO_LARGE", 413, f"录音超过 {MAX_AUDIO_MB:g}MB")
    if len(data) < 1024:
        return error(request, "UNSUPPORTED_AUDIO", 415, "音频太短或为空")
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    if suffix.lower() not in {".webm", ".wav", ".mp3", ".m4a", ".mp4", ".ogg", ".opus", ".flac"}:
        return error(request, "UNSUPPORTED_AUDIO", 415, "不支持的音频格式")

    # 先探时长再推理：否则长录音会先把 CPU 吃满，然后才被拒绝。
    probed = probe_seconds(data, suffix)
    if probed is not None and probed > MAX_AUDIO_SECONDS:
        return error(request, "TOO_LARGE", 413, f"录音超过 {MAX_AUDIO_SECONDS} 秒")

    if not STORE.spend(session, "transcribe"):
        return error(request, "QUOTA_EXCEEDED", 429, "本次会话的识别次数用完了")

    backend = backend_or_none(ASR_CHAIN)
    if backend is None:
        return error(request, "NOT_CONFIGURED", 503, "服务端没有可用的识别能力")
    try:
        result = backend.transcribe(data, suffix, language)  # type: ignore[attr-defined]
    except ASRError as failure:
        mark_runtime("transcribe", failure.code)
        return error(request, failure.code, failure.status, "识别失败")
    # 探测失败（拿不到时长）时，这里再兜一次底。
    if result.duration_seconds and result.duration_seconds > MAX_AUDIO_SECONDS:
        return error(request, "TOO_LARGE", 413, f"录音超过 {MAX_AUDIO_SECONDS} 秒")
    mark_runtime("transcribe")
    STORE.bump("transcribe")
    LOG.info(
        "transcribe id=%s mode=%s bytes=%d ms=%d",
        request.state.request_id,
        result.mode,
        len(data),
        result.elapsed_ms,
    )
    return JSONResponse(
        {
            "request_id": request.state.request_id,
            "text": result.text,
            "mode": result.mode,
            "language": result.language,
            "duration_seconds": result.duration_seconds,
            "elapsed_ms": result.elapsed_ms,
        }
    )


class ReplyBody(BaseModel):
    text: str = ""
    translation: str = ""
    target_language: str = "en"


@app.post("/api/reply")
def reply(request: Request, body: ReplyBody) -> JSONResponse:
    session = require_session(request)
    if isinstance(session, JSONResponse):
        return session
    if not STORE.rate_ok(request.client.host if request.client else "unknown"):
        return error(request, "RATE_LIMITED", 429, "请求太频繁")
    if not body.text.strip():
        return error(request, "BAD_REQUEST", 400, "没有原文")
    # 回复接口和翻译一样要限长：它同样把文本丢给模型，同样要花钱。
    if len(body.text) > MAX_CHARS:
        return error(request, "TOO_LARGE", 413, "文本太长")
    if len(body.translation) > MAX_CHARS:
        return error(request, "TOO_LARGE", 413, "译文太长")
    if not STORE.spend(session, "reply"):
        return error(request, "QUOTA_EXCEEDED", 429, "本次会话的回复次数用完了")
    backend = backend_or_none(REPLY_CHAIN)
    if backend is None:
        return error(request, "NOT_CONFIGURED", 503, "服务端没有可用的回复能力")
    try:
        result = backend.reply(body.text, body.translation)  # type: ignore[attr-defined]
    except (UpstreamError, ReplyError) as failure:
        # 两套后端抛的异常类型不一样：ProviderReply 抛 ReplyError，
        # 旧代码只捕 UpstreamError，于是「上游超时」会变成 500 未捕获异常。
        mark_runtime("reply", failure.code)
        return error(request, failure.code, failure.status, "回复建议失败")
    mark_runtime("reply")
    STORE.bump("reply")
    return JSONResponse(
        {
            "request_id": request.state.request_id,
            "reply": result.reply,
            "meaning": result.meaning,
            "mode": result.mode,
            # 三条候选：一条「请对方打字/重复」、一条「确认理解」、一条场景回应。
            # 只给一条会逼使用者接受一个不该由程序替他做的选择。
            "suggestions": result.suggestions or [
                {"reply": result.reply, "meaning": result.meaning, "kind": "confirm"}
            ],
            "elapsed_ms": result.elapsed_ms,
        }
    )


@app.get("/api/stats")
def stats() -> dict:
    """只给计数，不含任何内容；用于自查与费用估算。"""
    return {"version": VERSION, "sessions": len(STORE.sessions), "counters": STORE.counters}


# --------------------------------------------------------------------------- #
# 静态站点：同一个进程同时提供前端（单端口部署，省掉跨域与额外托管）
# --------------------------------------------------------------------------- #

def _resolve_web_dist() -> Path:
    """
    前端产物目录。按候选顺序找，不写死一个路径。

    发布平台的打包会**排除 build output**（`dist/` 是典型目标），于是
    `web/dist` 可能在部署包里整个消失、前端变空白。所以部署包里改用
    `web/app`，这里两个名字都认。
    """
    env = os.getenv("COPILOT_WEB_DIST")
    if env:
        return Path(env)
    here = Path(__file__).resolve().parent
    for rel in ("../web/dist", "../web/app", "static", "../static"):
        candidate = (here / rel).resolve()
        if (candidate / "index.html").is_file():
            return candidate
    return (here / "../web/dist").resolve()


WEB_DIST = _resolve_web_dist()


@app.get("/", response_model=None)
def index():
    target = WEB_DIST / "index.html"
    if target.exists():
        return FileResponse(target)
    return JSONResponse({"ok": True, "hint": "前端还没构建：cd webapp/web && npm run build"})


@app.get("/{path:path}", response_model=None)
def static_files(path: str):
    root = WEB_DIST.resolve()
    candidate = (root / path).resolve()
    # `str(...).startswith(str(root))` 会把 `/srv/web-dist-evil/x` 也判成合法
    # （前缀相同）。改用真正的路径包含关系，并顺带挡掉符号链接逃逸。
    inside = candidate == root or root in candidate.parents
    if WEB_DIST.exists() and inside and candidate.is_file():
        return FileResponse(candidate)
    fallback = WEB_DIST / "index.html"
    if fallback.exists():
        return FileResponse(fallback)
    return JSONResponse({"error": {"code": "NOT_FOUND"}}, status_code=404)
