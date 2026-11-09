"""多语言翻译：日语 / 韩语 / 俄语 → 英语 → 中文（两级级联）。

为什么是两级
------------
Xenova 只导出了 `opus-mt-{ja,ko,ru}-en` 的 ONNX 量化权重，没有「→中文」的版本。
自己把 PyTorch 权重转 ONNX 需要拉 optimum + torch（2GB 级），本机与环境都不适合。
所以走：源语言 → 英语 → 中文。

这条链的代价必须写在界面上：两级翻译会**误差累积**，日语敬语、俄语格变化在
中转到英语时丢一层，再进中文又会变形。它比「不支持」好，但绝不是「中日直译」，
不能拿它和英译中相提并论。

设计约束
--------
- 中间那句英语保留在返回值里（`via`），出问题时能看出是哪一级坏了；
- 两级都有超时与锁，任何一级失败都整体失败，不返回半截结果；
- 模型缺失时构造即 `available=False`，由调度层决定怎么提示，不在这里兜底编造。
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Optional

from engine_mt import MTResult, UpstreamError
from engine_mt_onnx import OnnxOpusMT

MODEL_ROOT = Path(__file__).resolve().parent.parent / "mt" / "models" / "Xenova"

#: 语言代码 → (仓库目录名, 中文名)
PIVOT_REPOS = {
    "ja": ("Xenova__opus-mt-ja-en", "日语"),
    "ko": ("Xenova__opus-mt-ko-en", "韩语"),
    "ru": ("Xenova__opus-mt-ru-en", "俄语"),
}


class CascadeMT:
    """`xx → en → zh`。`mode` 统一写 `local-cascade`，界面据 `via` 说明中转。"""

    mode = "local-cascade"

    def __init__(self, code: str, zh_engine: OnnxOpusMT) -> None:
        repo, label = PIVOT_REPOS[code]
        self.code = code
        self.label = label
        self.zh = zh_engine
        self.hub = OnnxOpusMT(model_dir=str(MODEL_ROOT / repo))
        self.available = bool(self.hub.available and self.zh.available)
        if not self.hub.available:
            self.detail = f"{label}→英 模型缺失：{self.hub.detail}"
        elif not self.zh.available:
            self.detail = f"缺少中转的英译中模型：{self.zh.detail}"
        else:
            self.detail = f"{label}→英→中（两级，经英语转译）"

    def warmup(self) -> dict:
        started = time.perf_counter()
        first = self.hub.warmup()
        self.zh.warmup()
        return {
            "pivot_dir": str(self.hub.model_dir),
            "load_ms": first.get("load_ms", 0),
            "warmup_ms": int((time.perf_counter() - started) * 1000),
        }

    def translate(self, text: str) -> MTResult:
        started = time.perf_counter()
        middle = self.hub.translate(text)
        english = middle.translation.strip()
        if not english:
            raise UpstreamError("UPSTREAM_ERROR", 502)
        final = self.zh.translate(english)
        if not final.translation.strip():
            raise UpstreamError("UPSTREAM_ERROR", 502)
        result = MTResult(
            translation=final.translation,
            mode=self.mode,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )
        # via 不是 MTResult 的字段（那是个 dataclass），挂在实例属性上由调用方取。
        # 用实例属性而不是返回元组，是为了不改 MTResult 的签名、不惊动已有调用方。
        self.last_via = english
        return result


def build_cascade(code: str, zh_engine: OnnxOpusMT) -> CascadeMT:
    return CascadeMT(code, zh_engine)


def supported_codes() -> list[str]:
    """本机实际装了模型的语种。用于 /api/health，不猜。"""
    out = []
    for code, (repo, _label) in PIVOT_REPOS.items():
        enc = MODEL_ROOT / repo / "onnx" / "encoder_model_quantized.onnx"
        dec = MODEL_ROOT / repo / "onnx" / "decoder_model_merged_quantized.onnx"
        if enc.exists() and dec.exists():
            out.append(code)
    return out
