"""下载多语言翻译模型（日/韩/俄 → 英），走镜像站，逐个校验大小。

为什么要下载：日/韩/俄 没有现成的「→中文」ONNX 量化模型（Xenova 只导出了
`opus-mt-ja-en` / `opus-mt-ko-en` / `opus-mt-ru-en`），所以多语言走**两级**：
    日语/韩语/俄语 --(opus-mt-xx-en)--> 英语 --(opus-mt-en-zh)--> 中文

代价要写清楚：两级翻译比直译多一次误差累积。界面上「日语（经英语转译）」必须
标明，不能让使用者以为这是中日直译模型。

用法：
    ./.venv/Scripts/python.exe fetch_models.py ja ko ru

许可证：Helsinki-NLP 的 OPUS-MT 权重是 CC-BY-4.0，下载后在 `MODELS/NOTICE.md`
里记来源与许可，随包分发时必须一起带上。
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

# 必须先设镜像，再 import huggingface_hub（它读环境变量定 endpoint）
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

from huggingface_hub import snapshot_download  # noqa: E402

HERE = Path(__file__).resolve().parent
TARGET_ROOT = HERE.parent / "mt" / "models" / "Xenova"

REPOS = {
    "ja": "Xenova/opus-mt-ja-en",
    "ko": "Xenova/opus-mt-ko-en",
    "ru": "Xenova/opus-mt-ru-en",
}

#: 只要推理必需的文件。不拉 .bin / .safetensors —— 那是 PyTorch 权重，本机用不上，
#: 每个都多 300MB。
ALLOW = [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
]


def fetch(code: str) -> None:
    repo = REPOS[code]
    target = TARGET_ROOT / repo.replace("/", "__")
    print(f"[{code}] {repo} -> {target}", flush=True)
    started = time.time()
    path = snapshot_download(
        repo_id=repo,
        local_dir=str(target),
        allow_patterns=ALLOW,
        max_workers=2,
    )
    elapsed = time.time() - started
    total = sum(p.stat().st_size for p in Path(path).rglob("*") if p.is_file())
    print(f"[{code}] done in {elapsed:.0f}s, {total / 1024 / 1024:.1f}MB", flush=True)
    for name in ("onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx",
                 "tokenizer.json", "config.json"):
        p = Path(path) / name
        print(f"  {name}: {'OK ' + str(p.stat().st_size // 1024) + 'KB' if p.exists() else 'MISSING'}", flush=True)


def main() -> int:
    codes = [a.lower() for a in sys.argv[1:]] or ["ja", "ko", "ru"]
    unknown = [c for c in codes if c not in REPOS]
    if unknown:
        print(f"unknown language(s): {unknown}; pick from {list(REPOS)}")
        return 2
    for code in codes:
        try:
            fetch(code)
        except Exception as exc:  # noqa: BLE001 - 下载失败要如实报，不能静默
            print(f"[{code}] FAILED: {type(exc).__name__}: {exc}", flush=True)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
