"""30 例模型对照：同一批输入分别跑本地 ONNX 与（若配置了）云端 Provider。

为什么不用 HTTP 接口来跑对照：
- 接口一次只走一条链（`backend_or_none` 取第一个 available），没法同题对比；
- 走接口还会带上会话、配额、限流，噪音大而且可能触发限额。

所以这里直接实例化两个引擎，用同一段文本、同一温度、同一超时各跑一遍。
**输出原样保存**，不做任何挑选；下面那些 `flags` 只是机器初筛，用来提示人工重点看哪几句，
不能当成评分 —— 金额/时间/否定是否「意思对」必须人读。

用法：
  python compare_models.py                     # 默认读 outputs 里的 30 例
  python compare_models.py --cases <path> --out <path>
  COPILOT_LLM_BASE_URL=… COPILOT_LLM_API_KEY=… COPILOT_LLM_MODEL=… python compare_models.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

DEFAULT_CASES = Path(
    r"C:\Users\25344\Documents\Codex\2026-11-08\referenced-chatgpt-conversation-this-is-an"
    r"\outputs\95分目标改进\模型对照测试30例.json"
)
DEFAULT_OUT = HERE.parent.parent / "docs" / "evidence-web" / "compare30.json"

DIGITS = re.compile(r"\d+(?:[.,]\d+)?")
CN_DIGITS = "零一二三四五六七八九"


def cn_number(value: int) -> str:
    """0–9999 的中文读法，只用于「这个数有没有出现在译文里」这种粗筛。"""
    if value == 0:
        return "零"
    if value < 0 or value > 9999:
        return str(value)
    units = ["", "十", "百", "千"]
    digits = [int(ch) for ch in str(value)]
    out: list[str] = []
    zero_pending = False
    for index, digit in enumerate(digits):
        unit = units[len(digits) - index - 1]
        if digit == 0:
            zero_pending = True
            continue
        if zero_pending and out:
            out.append("零")
        zero_pending = False
        out.append(CN_DIGITS[digit] + unit)
    text = "".join(out)
    # 一十二 → 十二
    if text.startswith("一十"):
        text = text[1:]
    return text


def numbers_in(text: str) -> list[float]:
    hits: list[float] = []
    for raw in DIGITS.findall(text):
        try:
            hits.append(float(raw.replace(",", "")))
        except ValueError:
            continue
    return hits


NEGATION_EN = re.compile(r"\b(not|no longer|isn't|aren't|wasn't|weren't|never)\b", re.I)
NEGATION_ZH = re.compile(r"不|没有|并非|未|别")
# 币种要同时认中文和英文/符号，否则「27 euros → 27欧元」会被误判成凭空添加
CURRENCY_ZH = {"EUR": "欧元", "USD": "美元", "GBP": "英镑", "CNY": "元", "JPY": "日元"}
CURRENCY_IN_INPUT = {
    "EUR": re.compile(r"euro|€", re.I),
    "USD": re.compile(r"dollar|\$", re.I),
    "GBP": re.compile(r"pound|£", re.I),
    "JPY": re.compile(r"yen|¥|円", re.I),
    "CNY": re.compile(r"yuan|rmb|人民币|元", re.I),
}
DIRECTION = {"提前": "earlier", "延后": "later", "推迟": "postpone", "改到": "moved"}
SPACE_THOUSANDS = re.compile(r"(?<=\d)[\s\u00A0\u202F](?=\d{3})")


def normalize(text: str) -> str:
    """把 `2 460` 这种空格千分位拉平，否则数字检查会把 2460 误判成没出现。"""
    return SPACE_THOUSANDS.sub("", text)


def review_flags(case: dict, output: str) -> list[str]:
    """机器初筛。命中不代表错，只是提醒人工去看这一句。"""
    flags: list[str] = []
    output_norm = normalize(output)

    missing: list[float] = []
    for value in numbers_in(case["input"]):
        if value != int(value):
            continue
        whole = int(value)
        forms = {str(whole), f"{whole:,}", cn_number(whole)}
        if not any(form and form in output_norm for form in forms):
            missing.append(value)
    if missing:
        flags.append("数没对上：" + "、".join(str(int(v)) for v in missing))

    if NEGATION_EN.search(case["input"]) and not NEGATION_ZH.search(output):
        flags.append("原文有否定，译文没看出否定")

    mentioned = {code for code, pattern in CURRENCY_IN_INPUT.items() if pattern.search(case["input"])}
    for code, word in CURRENCY_ZH.items():
        if word not in output:
            continue
        if code in mentioned:
            continue
        # 「元」太宽（欧元/美元都含元），单独处理：原文没有任何币种时才算凭空补
        if code == "CNY" and mentioned:
            continue
        flags.append(f"译文出现原文没有的币种「{word}」")

    for zh, en in DIRECTION.items():
        if zh in output and not re.search(en, case["input"], re.I):
            flags.append(f"译文说「{zh}」，原文没有对应方向词")

    return flags


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--only", default="", help="只跑这些 id，逗号分隔")
    args = parser.parse_args()

    data = json.loads(args.cases.read_text(encoding="utf-8"))
    cases = data["cases"]
    if args.only:
        wanted = {item.strip() for item in args.only.split(",") if item.strip()}
        cases = [case for case in cases if case["id"] in wanted]

    backends: list[object] = []
    from engine_mt_onnx import OnnxOpusMT

    print("[compare] 加载本地 ONNX…", flush=True)
    onnx = OnnxOpusMT()
    backends.append(onnx)

    from engine_mt import ProviderMT

    provider = ProviderMT()
    if provider.available:
        print(f"[compare] 云端候选可用：{provider.model}", flush=True)
        backends.append(provider)
    else:
        print("[compare] 云端候选未配置（COPILOT_LLM_* 缺失），本次只跑本地这一列", flush=True)

    records = []
    for index, case in enumerate(cases, start=1):
        row: dict = {
            "id": case["id"],
            "category": case["category"],
            "input": case["input"],
            "reference_meaning_zh": case["reference_meaning_zh"],
            "critical_expected_facts": case.get("critical_expected_facts", {}),
            "must_not_invent": case.get("must_not_invent", {}),
            "outputs": {},
        }
        for backend in backends:
            started = time.perf_counter()
            try:
                result = backend.translate(case["input"])
                elapsed = int((time.perf_counter() - started) * 1000)
                row["outputs"][result.mode] = {
                    "ok": True,
                    "text": result.translation,
                    "elapsed_ms": result.elapsed_ms,
                    "wall_ms": elapsed,
                    "flags": review_flags(case, result.translation),
                }
            except Exception as error:  # 失败要如实记录，不能跳过
                elapsed = int((time.perf_counter() - started) * 1000)
                row["outputs"][getattr(backend, "mode", "unknown")] = {
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                    "wall_ms": elapsed,
                    "flags": [],
                }
        records.append(row)
        summary = " | ".join(
            f"{mode}: {'ok' if item['ok'] else 'FAIL'} {item.get('wall_ms', 0)}ms"
            for mode, item in row["outputs"].items()
        )
        print(f"[{index:02d}/{len(cases)}] {case['id']}  {summary}", flush=True)

    total_flags = sum(len(item["flags"]) for row in records for item in row["outputs"].values())
    failures = sum(1 for row in records for item in row["outputs"].values() if not item["ok"])
    payload = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "cases_file": str(args.cases),
        "case_count": len(records),
        "backends": [getattr(backend, "mode", "?") for backend in backends],
        "provider_model": provider.model if provider.available else None,
        "disclaimer": (
            "flags 是关键词/数字的机器初筛，只用于提示人工重点复核，不是正确率评分；"
            "金额、时间、日期、否定与更正关系必须人工按 reference_meaning_zh 判断。"
        ),
        "flag_total": total_flags,
        "failure_total": failures,
        "records": records,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf8")
    print(f"\n[compare] 写入 {args.out}")
    print(f"[compare] {len(records)} 例 · 失败 {failures} · 机器初筛提示 {total_flags} 处")


if __name__ == "__main__":
    main()
