"""校验（或下载）本地模型文件。

为什么单独有这个脚本：模型 257MB，不适合进 Git；但「运行时偷偷下载」是明确
禁止的。所以下载只发生在这里（构建/准备阶段），运行时 `local_files_only`。
版本按 **文件内容摘要** 锁定，不按分支名 —— 上游改了什么都能被发现。

用法：
  python fetch_models.py --check              # 只校验现有文件
  python fetch_models.py --download           # 从 hf-mirror 拉取缺失/损坏的文件
  python fetch_models.py --download --base https://huggingface.co

默认目录按仓库布局推导（webapp/deploy 的上一级）。
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import urllib.request
from pathlib import Path
from typing import NamedTuple

WEBAPP = Path(__file__).resolve().parent.parent

# 来源仓库 + 期望摘要。摘要由本机实测文件算出，见 docs/网站部署与运行-0.7.0-web.md
FILES: list["Item"] = []


class Item(NamedTuple):
    repo: str
    remote: str          # 仓库内路径
    local: Path          # 落地位置
    sha256: str
    size: int


def _items() -> list[Item]:
    whisper = WEBAPP / "server" / "models" / "faster-whisper-base"
    opus = WEBAPP / "mt" / "models" / "Xenova" / "opus-mt-en-zh"
    return [
        Item("Systran/faster-whisper-base", "model.bin", whisper / "model.bin",
             "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9", 145217532),
        Item("Systran/faster-whisper-base", "config.json", whisper / "config.json",
             "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a", 2309),
        Item("Systran/faster-whisper-base", "tokenizer.json", whisper / "tokenizer.json",
             "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab", 2203239),
        Item("Systran/faster-whisper-base", "vocabulary.txt", whisper / "vocabulary.txt",
             "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913", 459861),
        Item("Xenova/opus-mt-en-zh", "onnx/encoder_model_quantized.onnx",
             opus / "onnx" / "encoder_model_quantized.onnx",
             "d3b7912bf6a9bd27e4c074c2df91d4ff3d5b4bc5f7f6c8d7cc9c805c98fbafee", 52899742),
        Item("Xenova/opus-mt-en-zh", "onnx/decoder_model_merged_quantized.onnx",
             opus / "onnx" / "decoder_model_merged_quantized.onnx",
             "023be4f841f4c47cd65fffcbaa81c0d99d7f7e0138f7ba0e03fa220a4e688aff", 60212804),
        Item("Xenova/opus-mt-en-zh", "tokenizer.json", opus / "tokenizer.json",
             "d0c7da27056e8f42adce9e76d8e792e5daa64e15f5acd2e7aabf0121877dd4c1", 6380952),
        Item("Xenova/opus-mt-en-zh", "config.json", opus / "config.json",
             "4727d1229a04f95bf6f39abf949d8080615433d99d6ebd85f81c09edd247d5fa", 1503),
    ]


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify(items: list[Item]) -> list[Item]:
    bad: list[Item] = []
    for item in items:
        if not item.local.exists():
            print(f"MISSING {item.local}")
            bad.append(item)
            continue
        got = sha256_of(item.local)
        if got != item.sha256:
            print(f"MISMATCH {item.local}\n  期望 {item.sha256}\n  实际 {got}")
            bad.append(item)
        else:
            print(f"OK      {item.local.relative_to(WEBAPP)} ({item.size} 字节)")
    return bad


def download(items: list[Item], base: str) -> None:
    for item in items:
        url = f"{base.rstrip('/')}/{item.repo}/resolve/main/{item.remote}"
        item.local.parent.mkdir(parents=True, exist_ok=True)
        tmp = item.local.with_suffix(item.local.suffix + ".part")
        print(f"GET {url}")
        with urllib.request.urlopen(url, timeout=120) as response, tmp.open("wb") as fh:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
        got = sha256_of(tmp)
        if got != item.sha256:
            tmp.unlink(missing_ok=True)
            raise SystemExit(f"摘要不符，已删除：{item.local}（实际 {got}）")
        tmp.replace(item.local)
        print(f"  -> {item.local}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--base", default="https://hf-mirror.com")
    args = parser.parse_args()

    items = _items()
    if args.download:
        missing = [i for i in items if not i.local.exists() or sha256_of(i.local) != i.sha256]
        if missing:
            download(missing, args.base)
    bad = verify(items)
    if bad:
        print(f"\n{len(bad)} 个文件缺失或摘要不符。运行 --download，或按上面路径手工放置。")
        return 1
    print("\n全部模型文件与摘要一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
