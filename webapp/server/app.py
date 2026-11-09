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
from engine_mt import UpstreamError, build_mt_chain, choose_mt
from engine_reply import ReplyError, build_reply_chain, choose_reply

VERSION = "0.7.0-web.4"  # 网页版独立版本号，与桌面 App 的 0.6.2 不是一个东西
BUILD_ID = os.getenv("COPILOT_BUILD_ID", "web4-2026-11-09")
# 每个进程一个短 ID：用来判「请求是不是被不同实例/重启后的进程接走的」。
# 不含任何用户数据，可以安全地出现在 /api/health 里。
BOOT_ID = secrets.token_hex(4)
BOOT_AT = time.time()
MAX_CHARS = int(os.getenv("COPILOT_MAX_CHARS", "2000"))
MAX_AUDIO_MB = float(os.getenv("COPILOT_MAX_AUDIO_MB", "8"))
MAX_AUDIO_SECONDS = int(os.getenv("COPILOT_MAX_AUDIO_SECONDS", "60"))
QUOTA_TRANSLATE = int(os.getenv("COPILOT_QUOTA_TRANSLATE", "40"))
QUOTA_TRANSCRIBE = int(os.getenv("COPILOT_QUOTA_TRANSCRIBE", "10"))
QUOTA_REPLY = int(os.getenv("COPILOT_QUOTA_REPLY", "15"))
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
ASR_CHAIN: list[object] = []
ASR_DETAIL: dict[str, str] = {}
REPLY_CHAIN: list[object] = []
REPLY_DETAIL: dict[str, str] = {}


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
    if body.source_language != "en" or body.target_language != "zh":
        return error(request, "BAD_REQUEST", 400, "这版只做英语 → 中文")

    if not STORE.spend(session, "translate"):
        return error(request, "QUOTA_EXCEEDED", 429, "本次会话的翻译次数用完了")

    backend = backend_or_none(MT_CHAIN)
    if backend is None:
        return error(request, "NOT_CONFIGURED", 503, "服务端没有可用的翻译能力")
    try:
        result = backend.translate(text)  # type: ignore[attr-defined]
    except UpstreamError as failure:
        mark_runtime("translate", failure.code)
        if failure.code == "MODE_DISABLED":
            return error(request, "NO_PRESET", 503, "演示模式下没有这句的预置译文")
        return error(request, failure.code, failure.status, "上游模型失败")
    mark_runtime("translate")
    STORE.bump("translate")
    LOG.info(
        "translate id=%s mode=%s chars=%d ms=%d",
        request.state.request_id,
        result.mode,
        len(text),
        result.elapsed_ms,
    )
    return JSONResponse(
        {
            "request_id": request.state.request_id,
            "translation": result.translation,
            "mode": result.mode,
            "source_language": "en",
            "target_language": "zh",
            "elapsed_ms": result.elapsed_ms,
        }
    )


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
