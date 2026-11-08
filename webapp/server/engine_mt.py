"""翻译后端：本地 Argos（真实、离线）／OpenAI 兼容接口（真实、云端）／预置（mock）。

设计约束：
- 前端永远拿不到 Key，也不接受任意上游地址。上游地址只在这里从环境变量读。
- 三种模式必须能被 `/api/health` 与每条响应区分开，界面据此标「真实」还是「预置」。
- 上游错误只保留错误码与 HTTP 状态，**不保留响应正文**（服务商常把请求内容回显在错误里）。
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx

LOG = logging.getLogger("copilot.mt")

UPSTREAM_TIMEOUT = float(os.getenv("COPILOT_UPSTREAM_TIMEOUT", "20"))

# 预置样例的三句中文（与桌面端 samples.ts 的 zh-en 变体一致）。
# 它只用于 mock 模式，且界面会明确标注「预置演示」。
PRESET: dict[str, str] = {
    "Please send the report by 3 p.m. tomorrow.": "请在明天下午三点前把报告发过来。",
    "The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.": "会议不在周二，改到周四上午 10 点 30 分了。",
    "The budget is fifteen thousand, not fifty thousand.": "预算是一万五千，不是五万。",
}


class UpstreamError(Exception):
    """上游失败。只带安全错误码，不带正文。"""

    def __init__(self, code: str, status: int = 502) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass
class MTResult:
    translation: str
    mode: str
    elapsed_ms: int


class LocalOpusMT:
    """本地 Opus-MT（transformers.js 边车，ONNX 量化）。

    模型在 `webapp/mt/models` 里，边车运行时 `allowRemoteModels=false`：
    断网可用，也不会偷偷下载。句子结构与数字保持得比通用小模型稳，适合核对场景。
    """

    mode = "local-opus"

    def __init__(self) -> None:
        self.base = (os.getenv("COPILOT_MT_URL") or "http://127.0.0.1:8100").rstrip("/")
        self.available = False
        self.detail = "本地翻译边车未启动（node webapp/mt/server.mjs）"
        try:
            with httpx.Client(timeout=2.0, trust_env=False) as client:
                response = client.get(f"{self.base}/health")
            if response.status_code != 200:
                self.detail = f"边车健康检查 HTTP {response.status_code}"
                return
            body = response.json()
            if not body.get("ok"):
                self.detail = "边车报告未就绪"
                return
            self.available = True
            self.detail = f"本地 Opus-MT（{body.get('model')}，加载 {body.get('load_ms')}ms）"
        except httpx.HTTPError:
            self.detail = "本地翻译边车不可达（127.0.0.1:8100）"

    def translate(self, text: str) -> MTResult:
        started = time.perf_counter()
        try:
            with httpx.Client(timeout=UPSTREAM_TIMEOUT, trust_env=False) as client:
                response = client.post(f"{self.base}/translate", json={"text": text})
        except httpx.TimeoutException as error:
            raise UpstreamError("UPSTREAM_TIMEOUT", 504) from error
        except httpx.HTTPError as error:
            raise UpstreamError("UPSTREAM_ERROR", 502) from error
        if response.status_code >= 400:
            LOG.warning("local mt status=%s", response.status_code)
            raise UpstreamError("UPSTREAM_ERROR", 502)
        body = response.json()
        return MTResult(
            translation=str(body.get("translation", "")).strip(),
            mode=self.mode,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )


class ProviderMT:
    """OpenAI 兼容的 /chat/completions。地址固定，不接受前端传入。"""

    mode = "provider"

    def __init__(self) -> None:
        self.base_url = (os.getenv("COPILOT_LLM_BASE_URL") or "").rstrip("/")
        self.api_key = os.getenv("COPILOT_LLM_API_KEY") or ""
        self.model = os.getenv("COPILOT_LLM_MODEL") or ""
        self.available = bool(self.base_url and self.api_key and self.model)
        self.detail = (
            f"云端模型 {self.model}"
            if self.available
            else "未配置 COPILOT_LLM_BASE_URL / _API_KEY / _MODEL"
        )

    def translate(self, text: str) -> MTResult:
        started = time.perf_counter()
        system = (
            "You are a translation engine. Translate English into Simplified Chinese. "
            "Keep numbers, times, currency and negations exactly as stated. "
            "Output only the translation, no notes."
        )
        payload = {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": text},
            ],
        }
        headers = {"authorization": f"Bearer {self.api_key}", "content-type": "application/json"}
        try:
            with httpx.Client(timeout=UPSTREAM_TIMEOUT) as client:
                response = client.post(f"{self.base_url}/chat/completions", json=payload, headers=headers)
        except httpx.TimeoutException as error:
            raise UpstreamError("UPSTREAM_TIMEOUT", 504) from error
        except httpx.HTTPError as error:
            raise UpstreamError("UPSTREAM_ERROR", 502) from error

        if response.status_code == 429:
            raise UpstreamError("UPSTREAM_ERROR", 503)
        if response.status_code >= 400:
            # 只记状态，不把 body 带出去。
            LOG.warning("mt upstream status=%s", response.status_code)
            raise UpstreamError("UPSTREAM_ERROR", 502)
        try:
            body = response.json()
            content = body["choices"][0]["message"]["content"]
        except Exception as error:
            raise UpstreamError("UPSTREAM_ERROR", 502) from error
        text_out = str(content).strip()
        if not text_out:
            raise UpstreamError("UPSTREAM_ERROR", 502)
        return MTResult(
            translation=text_out,
            mode=self.mode,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )


class MockMT:
    """预置结果。只认三组样例，其它输入明确说「没有预置」。"""

    mode = "mock"

    def __init__(self) -> None:
        self.available = True
        self.detail = "预置演示（没有真实翻译模型）"

    def translate(self, text: str) -> MTResult:
        key = text.strip()
        if key in PRESET:
            return MTResult(translation=PRESET[key], mode=self.mode, elapsed_ms=0)
        raise UpstreamError("MODE_DISABLED", 503)


def build_mt_chain() -> tuple[list[object], dict[str, str]]:
    """按环境变量决定优先级；返回可用链与每路的说明。

    默认第一路是 **进程内 ONNX**（`local-onnx`）：只依赖 Python，部署不用带
    Node 运行时，实测也比 HTTP 边车快。`local-opus`（Node 边车）保留为可选，
    设 `COPILOT_TRANSLATE_ORDER=local-opus,provider,mock` 即可切回。
    """
    order = os.getenv("COPILOT_TRANSLATE_ORDER", "local-onnx,provider,mock")
    instances: dict[str, object] = {
        "provider": ProviderMT(),
        "mock": MockMT(),
    }
    # 本地模型加载较重，且失败信息要能自解释，所以按需构建
    if "local-onnx" in order:
        from engine_mt_onnx import OnnxOpusMT

        instances["local-onnx"] = OnnxOpusMT()
    if "local-opus" in order:
        instances["local-opus"] = LocalOpusMT()
    details = {name: getattr(instance, "detail", "") for name, instance in instances.items()}
    chain = [instances[name] for name in order.split(",") if name in instances]
    return chain, details


def choose_mt(chain: list[object]) -> Optional[object]:
    for backend in chain:
        if getattr(backend, "available", False):
            return backend
    return None
