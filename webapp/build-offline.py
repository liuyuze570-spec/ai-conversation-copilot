"""把网页版打包成「断网也能用」的便携目录。

结构（输出目录里）：

    python\\python.exe        自带 CPython 3.12（uv 装的那份）
    server\\                   FastAPI + 两个引擎 + 启动器
    models\\faster-whisper-base
    mt-models\\Xenova\\opus-mt-en-zh
    web\\                      前端构建产物
    启动.bat / 启动（断网自检）.bat

为什么不用 `pip install` 重新装一遍：本机 `.venv` 里的轮子已经和这两个模型
跑通过（1045 条单测 + 离线验证），重装只会引入版本漂移。这里直接搬
site-packages，再在 `--check` 里用**包内的 python** 真的 import 一遍。

用法：

    python webapp/build-offline.py                # 产出到 F:\\copilot-release\\offline-web-0.7.0
    python webapp/build-offline.py --out D:\\x    # 换目录
    python webapp/build-offline.py --check        # 只检查现有产物能否 import
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent
SERVER = HERE / "server"
VENV = SERVER / ".venv"
DEFAULT_OUT = Path("F:/copilot-release/offline-web-0.7.0")

# 只搬服务端真正要用的文件，别把 testdata / 测试脚本一起塞进去
SERVER_FILES = [
    "app.py",
    "engine_asr.py",
    "engine_mt.py",
    "engine_mt_onnx.py",
    "engine_reply.py",
    "offline_guard.py",
    "run_offline.py",
    "requirements.txt",
]

LAUNCHER = """@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动离线版（首次启动要加载模型，约 2 秒）...
"%~dp0python\\python.exe" "%~dp0server\\run_offline.py"
if errorlevel 1 pause
"""

LAUNCHER_GUARD = """@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 断网自检模式：除本机回环以外，一切出站连接都会被拦下并计数。
"%~dp0python\\python.exe" "%~dp0server\\run_offline.py" --guard
echo.
echo 关闭窗口前，上面那行「出站拦截 N 次」就是结论；N=0 说明整条链路没试过联网。
pause
"""


def venv_base() -> Path:
    """从 pyvenv.cfg 读出 venv 依赖的 CPython 安装目录。"""
    cfg = VENV / "pyvenv.cfg"
    if not cfg.exists():
        raise SystemExit(f"找不到 {cfg}，先把 webapp/server/.venv 建好")
    for line in cfg.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("home"):
            base = line.split("=", 1)[1].strip()
            path = Path(base)
            if not (path / "python.exe").exists():
                raise SystemExit(f"pyvenv.cfg 里的解释器不存在：{path}")
            return path
    raise SystemExit("pyvenv.cfg 里没有 home 一行")


def copytree(src: Path, dst: Path, ignore=None) -> None:
    """覆盖式复制：目标已存在就合并，不先删整棵目录。

    先 `rmtree` 再复制有一次把旧包删了一半、新包没写进去的经历（批量删除被
    安全策略拦下，脚本停在中间）。覆盖式复制最坏情况是留下几个旧文件，
    比留下半个包好得多；要彻底重来用 `--fresh`。
    """
    if dst.exists():
        shutil.copytree(src, dst, ignore=ignore, dirs_exist_ok=True)
    else:
        shutil.copytree(src, dst, ignore=ignore)


def build(out: Path, fresh: bool = False) -> None:
    base = venv_base()
    print(f"[build] 解释器 {base}")
    print(f"[build] 输出   {out}")
    if fresh and out.exists():
        print("[build] --fresh：删掉旧产物")
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    print("[build] 1/6 复制 Python 运行时")
    copytree(base, out / "python", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    print("[build] 2/6 复制依赖（site-packages，约 370MB）")
    sp_dst = out / "python" / "Lib" / "site-packages"
    sp_dst.mkdir(parents=True, exist_ok=True)
    for entry in (VENV / "Lib" / "site-packages").iterdir():
        if entry.name in ("__pycache__",):
            continue
        target = sp_dst / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target, dirs_exist_ok=True,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy2(entry, target)

    print("[build] 3/6 复制服务端代码")
    server_out = out / "server"
    server_out.mkdir(exist_ok=True)
    for name in SERVER_FILES:
        shutil.copy2(SERVER / name, server_out / name)
    # 包内自带两条测试音频：换机器后 `--selfcheck` 不需要外部文件就能自证
    selftest = server_out / "selftest"
    selftest.mkdir(exist_ok=True)
    for wav in (SERVER / "testdata" / "offline").glob("*.wav"):
        shutil.copy2(wav, selftest / wav.name)

    print("[build] 4/6 复制模型")
    copytree(SERVER / "models" / "faster-whisper-base", out / "models" / "faster-whisper-base")
    copytree(
        HERE / "mt" / "models" / "Xenova" / "opus-mt-en-zh",
        out / "mt-models" / "Xenova" / "opus-mt-en-zh",
    )

    print("[build] 5/6 复制前端产物")
    dist = HERE / "web" / "dist"
    if not (dist / "index.html").exists():
        raise SystemExit("前端还没构建：先 cd webapp/web && npm run build")
    copytree(dist, out / "web")

    print("[build] 6/6 写启动脚本")
    # .bat 用 GBK 写：cmd.exe 按系统 OEM 代码页解析批处理，UTF-8 的中文会变成乱码
    (out / "启动.bat").write_bytes(LAUNCHER.replace("chcp 65001 >nul\n", "").encode("gbk"))
    (out / "启动（断网自检）.bat").write_bytes(
        LAUNCHER_GUARD.replace("chcp 65001 >nul\n", "").encode("gbk")
    )
    (out / "自检.bat").write_bytes(
        (
            "@echo off\r\n"
            "cd /d \"%~dp0\"\r\n"
            "echo 断网自检：包内 python 跑一遍真实翻译与识别，结束打印拦截次数。\r\n"
            "\"%~dp0python\\python.exe\" \"%~dp0server\\run_offline.py\" --selfcheck\r\n"
            "pause\r\n"
        ).encode("gbk")
    )
    (out / "版本.txt").write_text(
        "离线便携版 0.7.0-web.1\n"
        "自带 CPython 3.12、faster-whisper base int8、Opus-MT en-zh（ONNX）\n"
        f"构建于 {os.environ.get('COMPUTERNAME', '')}，由 webapp/build-offline.py 生成\n",
        encoding="utf-8",
    )

    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"[build] 完成：{total / 1e6:.0f} MB / {sum(1 for _ in out.rglob('*'))} 个条目")


def check(out: Path) -> None:
    py = out / "python" / "python.exe"
    if not py.exists():
        raise SystemExit(f"没有 {py}")
    code = (
        "import fastapi, uvicorn, pydantic, httpx, multipart\n"
        "import faster_whisper, ctranslate2, onnxruntime, tokenizers, av, numpy\n"
        "print('imports ok')\n"
        "print('python', __import__('sys').version.split()[0])\n"
        "print('ct2', ctranslate2.__version__, 'ort', onnxruntime.__version__)\n"
    )
    result = subprocess.run([str(py), "-c", code], capture_output=True, text=True, timeout=180)
    print(result.stdout.strip())
    if result.returncode != 0:
        print(result.stderr.strip()[-2000:])
        raise SystemExit("包内解释器 import 失败")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--fresh", action="store_true", help="先删掉输出目录（会触发批量删除确认）")
    args = ap.parse_args()
    if args.check:
        check(args.out)
        return
    build(args.out, fresh=args.fresh)
    check(args.out)


if __name__ == "__main__":
    main()
