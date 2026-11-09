# 单进程镜像：一个容器同时提供网页与接口。
# 镜像里没有 Node，也没有 node_modules —— 翻译是进程内 ONNX 推理。
FROM python:3.12-slim

# faster-whisper(ctranslate2) 在 Debian slim 上需要 OpenMP 运行库
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    COPILOT_DATA_DIR=/app/data \
    COPILOT_WHISPER_DIR=/app/models/faster-whisper-base \
    COPILOT_MT_MODEL_DIR=/app/mt-models/Xenova/opus-mt-en-zh \
    COPILOT_WEB_DIST=/app/web-dist

WORKDIR /app

COPY server/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# 拷全部运行时模块：app.py 顶层 import 的 8 个本地模块一个都不能少。
# 旧版只拷了 5 个，漏掉 engine_mt_multi / phrasebook / feedback_store，
# 隔离环境里 `import app` 直接 ModuleNotFoundError。
# 不含 test_*.py / 离线脚本 / testdata —— 由显式清单与 .dockerignore 双重排除。
COPY server/app.py server/engine_asr.py server/engine_mt.py \
     server/engine_mt_multi.py server/engine_mt_onnx.py \
     server/engine_reply.py server/phrasebook.py server/feedback_store.py \
     server/run.py /app/

# 模型 / 前端在构建时进镜像：运行时不联网下载，路径与上面的环境变量一一对应。
#   server/models/faster-whisper-base -> /app/models/faster-whisper-base
#   mt/models/Xenova/opus-mt-en-zh   -> /app/mt-models/Xenova/opus-mt-en-zh
#   web/dist                         -> /app/web-dist
COPY server/models /app/models
COPY mt/models /app/mt-models
COPY web/dist /app/web-dist

# 反馈库落在 COPILOT_DATA_DIR=/app/data，声明为持久卷；
# 必须由平台挂载持久卷或换外置 DB，否则重新部署仍会丢（见 deploy/README.md）。
# 非 root 运行：先建好数据目录并授权，再声明 VOLUME（VOLUME 之后的目录改动不生效）。
RUN useradd --create-home --uid 10001 copilot \
 && mkdir -p /app/data \
 && chown -R copilot:copilot /app
VOLUME ["/app/data"]
USER copilot

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status==200 else 1)"

# 关掉默认 access_log：带 ?token= 的旧查询 URL 不该被原样写进日志。
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--proxy-headers", "--forwarded-allow-ips", "*"]
