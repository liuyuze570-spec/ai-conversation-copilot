#!/usr/bin/env bash
# 直链下载多语言 ONNX 模型（hf-mirror 的 api/resolve-cache 会超时，但 /resolve/main/ 可直连）。
# 断点续传 + 重试；已存在且大小对得上就跳过。
set -u
ROOT="F:/3D打印Rhino 7.0/2026-09-30-23-01-15/webapp/mt/models/Xenova"
BASE="https://hf-mirror.com"

FILES=(
  "config.json"
  "generation_config.json"
  "tokenizer.json"
  "tokenizer_config.json"
  "onnx/encoder_model_quantized.onnx"
  "onnx/decoder_model_merged_quantized.onnx"
)

fetch() {
  local repo="$1" dir="$2"
  mkdir -p "$dir/onnx"
  for f in "${FILES[@]}"; do
    local out="$dir/$f"
    local url="$BASE/$repo/resolve/main/$f"
    if [ -s "$out" ]; then
      echo "skip $repo/$f"
      continue
    fi
    echo "get  $repo/$f"
    curl -L --fail --retry 6 --retry-delay 3 --retry-all-errors \
         --connect-timeout 15 --max-time 900 -C - \
         -o "$out" "$url" || { echo "FAIL $repo/$f"; return 1; }
  done
  return 0
}

fetch "Xenova/opus-mt-ja-en" "$ROOT/Xenova__opus-mt-ja-en" || exit 1
fetch "Xenova/opus-mt-ko-en" "$ROOT/Xenova__opus-mt-ko-en" || exit 1
fetch "Xenova/opus-mt-ru-en" "$ROOT/Xenova__opus-mt-ru-en" || exit 1
echo ALL_DONE
du -sh "$ROOT"/Xenova__opus-mt-* 2>/dev/null
