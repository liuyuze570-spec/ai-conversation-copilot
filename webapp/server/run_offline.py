"""离线便携版启动器：自带 Python 与模型，不联网也能翻译和识别。

和 `uvicorn app:app` 的区别只有一个——**路径都由这个文件自己算**。
便携版里没有 `webapp/` 这层目录，也没有 `.venv`，所以不能依赖相对仓库的默认值。

用法（便携版根目录）：

    python\\python.exe server\\run_offline.py
    python\\python.exe server\\run_offline.py --guard   # 装断网守卫后再启动

`--guard` 会把除回环以外的一切出站连接拦掉；退出时打印拦截次数。
0 次 = 整条链路根本没试过联网。这是**进程级**限制，不是拔网线。
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = HERE.parent

DEFAULT_PORT = int(os.environ.get("PORT") or 8765)


def _pick_port(start: int) -> int:
    """端口被占就往后找，最多试 20 个。"""
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise SystemExit(f"8765–{start + 19} 都被占用了，先关掉占端口的程序再启动")


def _wire_env() -> None:
    """把模型与前端目录指到便携包里的位置；已经设了环境变量的不覆盖。"""
    whisper = BASE / "models" / "faster-whisper-base"
    if whisper.is_dir():
        os.environ.setdefault("COPILOT_WHISPER_DIR", str(whisper))
    mt = BASE / "mt-models" / "Xenova" / "opus-mt-en-zh"
    if mt.is_dir():
        os.environ.setdefault("COPILOT_MT_MODEL_DIR", str(mt))
    web = BASE / "web"
    if web.is_dir():
        os.environ.setdefault("COPILOT_WEB_DIST", str(web))
    # 便携版默认不连任何外部服务；真要用云端得自己显式给 Key
    os.environ.setdefault("COPILOT_OFFLINE", "1")


def _find_edge() -> str | None:
    """找 Edge 的可执行文件；找不到返回 None，不抛异常。"""
    candidates = [
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
        / "Microsoft"
        / "Edge"
        / "Application"
        / "msedge.exe",
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
        / "Microsoft"
        / "Edge"
        / "Application"
        / "msedge.exe",
    ]
    for path in candidates:
        if path.exists():
            return str(path)
    return None


def _selfcheck() -> int:
    """在断网守卫下把翻译和识别各跑一遍，打印拦截次数。

    和 `--guard` 起服务再点页面相比，这个模式不需要人操作、不需要端口，
    适合「换一台机器后先确认包是好的」。用的是包内自带的测试音频。
    """
    from offline_guard import blocked, install

    install()
    _wire_env()

    import json

    from fastapi.testclient import TestClient

    from app import app

    wav = HERE / "selftest" / "o1-platform.wav"
    report = {"ok": False}
    with TestClient(app) as client:
        health = client.get("/api/health").json()
        session = client.post("/api/session")
        cookies = session.cookies
        translation = client.post(
            "/api/translate",
            json={"text": "The budget is twelve thousand, not twenty thousand.", "from": "en", "to": "zh"},
            cookies=cookies,
        ).json()
        transcript = {}
        if wav.exists():
            with wav.open("rb") as handle:
                transcript = client.post(
                    "/api/transcribe",
                    files={"audio": (wav.name, handle, "audio/wav")},
                    cookies=cookies,
                ).json()
        report = {
            "version": health.get("version"),
            "translate_mode": health.get("mode", {}).get("translate"),
            "transcribe_mode": health.get("mode", {}).get("transcribe"),
            "translation": translation.get("translation"),
            "translate_ms": translation.get("elapsed_ms"),
            "transcript": transcript.get("text"),
            "transcribe_ms": transcript.get("elapsed_ms"),
            "blocked": len(blocked()),
        }
        report["ok"] = bool(
            translation.get("mode") == "local-onnx"
            and transcript.get("mode") == "local-whisper"
            and report["blocked"] == 0
        )
    print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0 if report["ok"] else 1


def main() -> None:
    if "--selfcheck" in sys.argv:
        raise SystemExit(_selfcheck())

    guard = "--guard" in sys.argv
    if guard:
        # 必须在导入 app（进而导入 httpx / onnxruntime）之前装
        from offline_guard import blocked, install

        install()

    _wire_env()

    port = _pick_port(int(os.environ.get("PORT") or DEFAULT_PORT))
    host = os.environ.get("COPILOT_HOST") or "127.0.0.1"

    import uvicorn

    from app import app

    url = f"http://{host}:{port}/"
    print(f"[offline] 目录 {BASE}")
    print(f"[offline] 识别模型 {os.environ.get('COPILOT_WHISPER_DIR')}")
    print(f"[offline] 翻译模型 {os.environ.get('COPILOT_MT_MODEL_DIR')}")
    print(f"[offline] 打开 {url}")

    def _open() -> None:
        time.sleep(1.6)
        # 优先用 Edge 的「应用窗口」打开：没有地址栏，看起来就是一个独立程序，
        # 也不会和用户正在用的浏览器标签混在一起。找不到就退回默认浏览器。
        edge = _find_edge()
        if edge:
            try:
                import subprocess

                subprocess.Popen(
                    [edge, f"--app={url}", "--window-size=480,920"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return
            except Exception:
                pass
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open, daemon=True).start()
    try:
        uvicorn.run(app, host=host, port=port, log_level="info")
    finally:
        if guard:
            hits = blocked()
            print(f"[offline] 出站拦截 {len(hits)} 次")
            for item in hits[:10]:
                print(f"  - {item}")


if __name__ == "__main__":
    main()
