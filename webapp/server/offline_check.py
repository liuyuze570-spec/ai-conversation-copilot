"""离线能力验证：进程级断网 → 真实识别 → 真实翻译。

为什么这么写：
- 用户明确要求「系统级断网或针对测试进程的出站限制」，不能只关浏览器网络面板。
  这里在 socket 层把**所有非回环出站连接**拦掉，并在结束后报告拦截次数。
  拦截次数为 0 说明整条链路根本没试过联网；大于 0 则逐条列出，不掩盖。
- 必须是**新进程**（每次运行都是一次冷启动），用来近似「重启程序后」。
- 输入是两条从未写进任何预置样例的句子，避免用样例自证。

用法：
  cd webapp/server
  ./.venv/Scripts/python.exe offline_check.py
结果写到 ../../docs/evidence-offline/offline-<时间戳>.json
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import os
import socket
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent.parent / "docs" / "evidence-offline"

BLOCKED: list[str] = []
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_real_getaddrinfo = socket.getaddrinfo


def _is_loopback(host) -> bool:
    if isinstance(host, bytes):
        host = host.decode("utf-8", "ignore")
    if not isinstance(host, str):
        return False
    return host in ("127.0.0.1", "::1", "localhost") or host.startswith("127.")


def _guard_connect(self, address):
    host = address[0] if isinstance(address, tuple) else address
    if isinstance(address, tuple) and _is_loopback(host):
        return _real_connect(self, address)
    BLOCKED.append(f"connect {address!r}")
    raise OSError("offline-guard: 出站连接被拦截")


def _guard_connect_ex(self, address):
    host = address[0] if isinstance(address, tuple) else address
    if isinstance(address, tuple) and _is_loopback(host):
        return _real_connect_ex(self, address)
    BLOCKED.append(f"connect_ex {address!r}")
    return 111


def _guard_getaddrinfo(host, *args, **kwargs):
    if _is_loopback(host):
        return _real_getaddrinfo(host, *args, **kwargs)
    BLOCKED.append(f"getaddrinfo {host!r}")
    raise socket.gaierror(-2, "offline-guard: DNS 被拦截")


def install_guard() -> None:
    socket.socket.connect = _guard_connect          # type: ignore[assignment]
    socket.socket.connect_ex = _guard_connect_ex    # type: ignore[assignment]
    socket.getaddrinfo = _guard_getaddrinfo         # type: ignore[assignment]
    # 环境里本来有 http_proxy，这里顺手清掉，避免误以为是代理功劳
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        os.environ.pop(key, None)


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD),
        ("PageFaultCount", wt.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def peak_memory_mb() -> float:
    counters = PROCESS_MEMORY_COUNTERS()
    counters.cb = ctypes.sizeof(counters)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    # 必须声明返回类型：句柄是指针大小，默认按 int 会被截断，调用必失败
    kernel32.GetCurrentProcess.restype = wt.HANDLE
    psapi.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD]
    psapi.GetProcessMemoryInfo.restype = wt.BOOL
    handle = kernel32.GetCurrentProcess()
    ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
    return round(counters.PeakWorkingSetSize / (1024 * 1024), 1) if ok else -1.0


def main() -> int:
    install_guard()

    # 导入放在拦截之后：如果某个库在导入时就想去拿模型，会被立刻抓住
    from engine_asr import LocalWhisper
    from engine_mt_onnx import OnnxOpusMT

    os.environ.setdefault("COPILOT_WHISPER_DIR", str(HERE / "models" / "faster-whisper-base"))

    cases = [
        ("o1-platform.wav", "The train leaves at seven forty-five from platform two."),
        ("o2-notlater.wav", "The delivery is not on Friday. It will arrive next Monday at 9 a.m."),
    ]

    report = {
        "when": datetime.now().isoformat(timespec="seconds"),
        "host": {
            "cpu": os.environ.get("PROCESSOR_IDENTIFIER", "?"),
            "logical_cpus": os.cpu_count(),
            "python": sys.version.split()[0],
        },
        "guard": "socket 层拦截所有非回环出站连接（connect / connect_ex / getaddrinfo）",
        "asr": {},
        "mt": {},
        "blocked_attempts": [],
        "note": "两条音频由本机 SAPI 合成，句子未出现在任何预置样例里",
    }

    t0 = time.perf_counter()
    asr = LocalWhisper()
    report["asr"]["available"] = asr.available
    report["asr"]["detail"] = asr.detail
    report["asr"]["load_ms"] = getattr(asr, "load_ms", None)
    report["startup_ms"] = int((time.perf_counter() - t0) * 1000)

    t1 = time.perf_counter()
    mt = OnnxOpusMT()
    report["mt"]["available"] = mt.available
    report["mt"]["detail"] = mt.detail
    report["mt"]["load_ms"] = mt.warmup().get("load_ms") if mt.available else None
    report["mt"]["startup_ms"] = int((time.perf_counter() - t1) * 1000)

    results = []
    for name, expect in cases:
        wav = HERE / "testdata" / "offline" / name
        if not wav.exists():
            results.append({"audio": name, "error": "缺少音频文件"})
            continue
        data = wav.read_bytes()
        item: dict = {"audio": name, "bytes": len(data), "expected_source": expect}

        if asr.available:
            started = time.perf_counter()
            try:
                out = asr.transcribe(data, ".wav", "en")
                item["asr"] = {
                    "mode": out.mode,
                    "text": out.text,
                    "language": out.language,
                    "audio_seconds": out.duration_seconds,
                    "elapsed_ms": out.elapsed_ms,
                    "wall_ms": int((time.perf_counter() - started) * 1000),
                }
            except Exception as exc:  # noqa: BLE001
                item["asr"] = {"error": f"{type(exc).__name__}: {exc}"}
        else:
            item["asr"] = {"error": asr.detail}

        text = (item.get("asr") or {}).get("text")
        if text and mt.available:
            started = time.perf_counter()
            try:
                mt_out = mt.translate(text)
                item["mt"] = {
                    "mode": mt_out.mode,
                    "translation": mt_out.translation,
                    "elapsed_ms": mt_out.elapsed_ms,
                    "wall_ms": int((time.perf_counter() - started) * 1000),
                }
            except Exception as exc:  # noqa: BLE001
                item["mt"] = {"error": f"{type(exc).__name__}: {exc}"}
        results.append(item)

    report["cases"] = results
    report["blocked_attempts"] = BLOCKED
    report["blocked_count"] = len(BLOCKED)
    report["peak_memory_mb"] = peak_memory_mb()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"offline-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\n写到 {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
