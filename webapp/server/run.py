"""部署启动入口（源码版；对应发布副本 app/run.py）。

与发布副本的差别只有一处：`access_log=False`。Uvicorn 默认访问日志会把请求
URL 原样写进 stdout，而反馈查询曾把一次性凭证放在 `?token=` 里（现已废弃：
前端改走 `X-Feedback-Token` 请求头，后端只保留短期兼容）。关掉默认 access_log，
兜住任何仍在用旧 URL 的调用，确保带凭据的 URL 不落进日志。

本文件是**源码**；发布副本 F:/copilot-deploy/app/run.py 本轮按要求未改动，
下次重新发布时请用本文件覆盖发布根目录的 run.py。
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 源码里 run.py 与 app.py 同目录；发布副本把 app.py 放在 server/ 子目录。
# 两种布局都把包含 app.py 的目录加进 sys.path，保证顶层模块 import 成立。
SERVER = HERE / "server" if (HERE / "server" / "app.py").is_file() else HERE
sys.path.insert(0, str(SERVER))

import uvicorn  # noqa: E402
from app import app  # noqa: E402

if __name__ == "__main__":
    port = int(os.getenv("PORT", "3000"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info", access_log=False)
