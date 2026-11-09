"""语音识别后端：本地 faster-whisper（真实）／云端转写接口（真实）／无（明确报错）。

三种失败都要能被界面读懂：
- 没装模型 → `NOT_CONFIGURED`（提示「服务端没有配置识别能力，先用文字输入」）
- 模型装了但解不了这个格式 → `UNSUPPORTED_AUDIO`
- 超时 → `UPSTREAM_TIMEOUT`
不允许返回一段编出来的假字幕。
"""

from __future__ import annotations

import io
import logging
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

LOG = logging.getLogger("copilot.asr")

UPSTREAM_TIMEOUT = float(os.getenv("COPILOT_ASR_TIMEOUT", "60"))

# 只影响书写格式（时间、金额的空格和小数点），不改写内容。
# 实测能把 "9am" 补成 "9 a.m."；"seven forty-five" 仍会被写成 "745"，
# 这一条修不了，已记进「已知问题」，不在这里猜着改数字。
ASR_PROMPT = "Times are written like 7:45 a.m. or 10:30 p.m. Numbers like 15,000 keep the comma."


class ASRError(Exception):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def _wav_seconds(data: bytes) -> float | None:
    """直接读 PCM WAV 头算时长，不依赖 PyAV。

    P2 标签页音频捕获在浏览器里切出来的就是 16-bit mono PCM WAV。
    音频时长预算要按真实秒数扣，所以对这种格式必须能稳定读到时长；
    PyAV 在某些容器组合上会返回 None，那种情况下也不能「按 0 秒」白嫖。
    """
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    pos = 12
    byte_rate = 0
    data_size: int | None = None
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        size = int.from_bytes(data[pos + 4 : pos + 8], "little")
        body = pos + 8
        if chunk_id == b"fmt " and size >= 16 and body + 16 <= len(data):
            byte_rate = int.from_bytes(data[body + 8 : body + 12], "little")
        elif chunk_id == b"data":
            data_size = size
            break
        pos = body + size + (size & 1)
    if data_size is None or byte_rate <= 0:
        return None
    seconds = data_size / byte_rate
    return seconds if seconds > 0 else None


def probe_seconds(data: bytes, suffix: str) -> float | None:
    """
    只读时长，不解码音频。

    为什么要在推理**之前**探：
    旧实现是 `backend.transcribe(...)` 跑完之后再看 `result.duration_seconds`
    —— 到那一步 CPU 已经为一个 5 分钟的录音算了几十秒，然后才回一句
    「录音超过 60 秒」。公网上这等于给了一个免费的算力放大器：
    谁都可以反复传长录音把机器占满。

    WAV 直接读头（见 `_wav_seconds`）；其它格式交给 PyAV。
    探不出来（老格式、损坏文件）返回 None，交给后面的流程自己报错，
    不在这里猜一个时长出来。
    """
    if suffix.lower() == ".wav":
        exact = _wav_seconds(data)
        if exact is not None:
            return exact
    try:
        import av  # faster-whisper 的依赖，已在 requirements 里锁定版本

        with av.open(io.BytesIO(data), metadata_errors="ignore") as container:
            if container.duration is not None:
                return float(container.duration) / 1_000_000.0
            stream = container.streams.audio[0] if container.streams.audio else None
            if stream is not None and stream.duration and stream.time_base:
                return float(stream.duration * stream.time_base)
    except Exception:  # noqa: BLE001 - 探测失败不该阻断正常识别
        return None
    return None


@dataclass
class ASRResult:
    text: str
    mode: str
    language: str
    duration_seconds: float | None
    elapsed_ms: int


def resolve_model_dir() -> str:
    """
    找本地识别模型，优先环境变量，其次按约定目录。

    部署环境没法保证能设环境变量，所以这里除了 `COPILOT_WHISPER_DIR`，
    还要认仓库约定下的两个位置。找不到就返回空串 —— 让上层明确报
    「未配置」，而不是悄悄去 HuggingFace 下载（那会引入运行时联网）。
    """
    env = os.getenv("COPILOT_WHISPER_DIR")
    if env:
        return env
    here = Path(__file__).resolve().parent
    candidates = [
        here / "models" / "faster-whisper-base",
        here.parent / "models" / "faster-whisper-base",
    ]
    for candidate in candidates:
        if candidate.is_dir():
            return str(candidate)
    return ""


class LocalWhisper:
    mode = "local-whisper"

    def __init__(self) -> None:
        self.available = False
        self.detail = "未安装 faster-whisper"
        model_dir = resolve_model_dir()
        allow_download = os.getenv("COPILOT_WHISPER_ALLOW_DOWNLOAD") == "1"
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except Exception as error:
            self.detail = f"faster-whisper 导入失败：{type(error).__name__}"
            return

        if not model_dir and not allow_download:
            self.detail = "未找到识别模型（COPILOT_WHISPER_DIR 或 server/models/faster-whisper-base）"
            return

        try:
            started = time.perf_counter()
            # 显式 local_files_only：模型必须在磁盘上，运行时不联网。
            self._model = WhisperModel(
                model_dir or "base",
                device=os.getenv("COPILOT_WHISPER_DEVICE", "cpu"),
                compute_type=os.getenv("COPILOT_WHISPER_COMPUTE", "int8"),
                local_files_only=not allow_download,
            )
            self.load_ms = int((time.perf_counter() - started) * 1000)
            self.available = True
            self.detail = f"本地 faster-whisper（{os.path.basename(model_dir) or 'base'}，加载 {self.load_ms}ms）"
        except Exception as error:  # pragma: no cover
            self.detail = f"模型加载失败：{type(error).__name__}"
            self.load_ms = 0

    def transcribe(self, data: bytes, suffix: str, language: str = "en") -> ASRResult:
        started = time.perf_counter()
        path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
                handle.write(data)
                path = handle.name
            segments, info = self._model.transcribe(
                path,
                language=language,
                vad_filter=True,
                # beam=1 会把 "3 p.m." 识别成 "3pm"、"9 a.m." 成 "9am"；
                # 实测改 5 能补回空格与标点，代价约 100–200ms，值得。
                beam_size=5,
                initial_prompt=ASR_PROMPT,
            )
            text = "".join(segment.text for segment in segments).strip()
            return ASRResult(
                text=text,
                mode=self.mode,
                language=getattr(info, "language", language),
                duration_seconds=float(getattr(info, "duration", 0.0)) or None,
                elapsed_ms=int((time.perf_counter() - started) * 1000),
            )
        except Exception as error:
            LOG.warning("local asr failed: %s", type(error).__name__)
            raise ASRError("UNSUPPORTED_AUDIO", 415) from error
        finally:
            if path:
                Path(path).unlink(missing_ok=True)


class ProviderASR:
    mode = "provider"

    def __init__(self) -> None:
        self.base_url = (os.getenv("COPILOT_STT_BASE_URL") or "").rstrip("/")
        self.api_key = os.getenv("COPILOT_STT_API_KEY") or ""
        self.model = os.getenv("COPILOT_STT_MODEL") or "whisper-1"
        self.available = bool(self.base_url and self.api_key)
        self.detail = (
            f"云端转写 {self.model}" if self.available else "未配置 COPILOT_STT_BASE_URL / _API_KEY"
        )

    def transcribe(self, data: bytes, suffix: str, language: str = "en") -> ASRResult:
        started = time.perf_counter()
        files = {"file": (f"audio{suffix}", data, "application/octet-stream")}
        form = {"model": self.model, "language": language}
        headers = {"authorization": f"Bearer {self.api_key}"}
        try:
            with httpx.Client(timeout=UPSTREAM_TIMEOUT) as client:
                response = client.post(
                    f"{self.base_url}/audio/transcriptions",
                    files=files,
                    data=form,
                    headers=headers,
                )
        except httpx.TimeoutException as error:
            raise ASRError("UPSTREAM_TIMEOUT", 504) from error
        except httpx.HTTPError as error:
            raise ASRError("UPSTREAM_ERROR", 502) from error
        if response.status_code >= 400:
            LOG.warning("asr upstream status=%s", response.status_code)
            raise ASRError("UPSTREAM_ERROR", 502)
        try:
            body = response.json()
        except Exception as error:
            raise ASRError("UPSTREAM_ERROR", 502) from error
        text = str(body.get("text", "")).strip()
        return ASRResult(
            text=text,
            mode=self.mode,
            language=language,
            duration_seconds=body.get("duration"),
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )


class UnavailableASR:
    mode = "mock"
    available = False
    detail = "没有可用的识别后端（既没有本地模型也没有云端配置）"
    load_ms = 0

    def transcribe(self, data: bytes, suffix: str, language: str = "en") -> ASRResult:
        raise ASRError("NOT_CONFIGURED", 503)


def build_asr_chain() -> tuple[list[object], dict[str, str]]:
    order = os.getenv("COPILOT_ASR_ORDER", "local,provider")
    local = LocalWhisper()
    provider = ProviderASR()
    instances = {"local": local, "provider": provider}
    details = {name: getattr(instance, "detail", "") for name, instance in instances.items()}
    chain = [instances[name] for name in order.split(",") if name in instances]
    if not any(getattr(item, "available", False) for item in chain):
        chain.append(UnavailableASR())
        details["none"] = UnavailableASR.detail
    return chain, details


def choose_asr(chain: list[object]) -> object:
    for backend in chain:
        if getattr(backend, "available", False):
            return backend
    return chain[-1]
