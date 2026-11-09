#!/bin/bash
# EC2 裸机部署启动脚本（user-data）：不打包 Docker，直接跑 Python 后端 + 前端构建。
# 设计目标：让「已部署 AWS 且可访问」用最少步骤、最少失败点达成。
# 全程自动：装工具 -> git clone -> pip 装后端 -> npm 构建前端 -> 跑 uvicorn。
#
# 本脚本采用「演示模式」：真实语音识别(faster-whisper)与真实翻译(onnxruntime/tokenizers)
# 是延迟导入，这里通过环境变量把链路切到 provider,mock，不装这些重包、不依赖模型文件。
# 前端常用语翻译走 phrasebook 查表，未命中走 mock 兜底（界面会明确标注）。
set -x
exec > /var/log/copilot-user-data.log 2>&1

REGION="ap-southeast-2"
REPO_URL="https://github.com/liuyuze570-spec/ai-conversation-copilot.git"

# ---------- 1. 基础工具 ----------
# Amazon Linux 2023：系统 Python 是 3.9（别动它，dnf 依赖它）。
# 我们装独立的 python3.12 + devel + gcc，保证 numpy 等 C 扩展能编译、版本和本机一致。
dnf update -y
dnf install -y git python3.12 python3.12-pip python3.12-devel gcc nodejs npm

# ---------- 2. 拉代码 ----------
cd /opt
rm -rf copilot-app
git clone --depth 1 "$REPO_URL" copilot-app
cd copilot-app/webapp

# ---------- 3. 建 venv 并装最小后端依赖 ----------
python3.12 -m venv /opt/copilot-venv
/opt/copilot-venv/bin/pip install --upgrade pip
/opt/copilot-venv/bin/pip install -r server/requirements-minimal.txt

# ---------- 4. 构建前端（web/dist 在 git 里被忽略，需现场构建）----------
cd web
npm install
npm run build
cd ..

# ---------- 5. 持久数据目录（反馈库）----------
# EBS 卷若已挂载到 /data，则用它；否则退回本地目录（不持久，仅演示）。
DATA_DIR="/data/appdata"
if mountpoint -q /data 2>/dev/null; then
  mkdir -p "$DATA_DIR"
else
  DATA_DIR="/opt/copilot-app/webapp/server/data"
  mkdir -p "$DATA_DIR"
fi

# ---------- 6. 用 systemd 常驻跑服务 ----------
cat > /etc/systemd/system/copilot.service <<EOF
[Unit]
Description=Copilot web backend
After=network.target

[Service]
WorkingDirectory=/opt/copilot-app/webapp/server
Environment=COPILOT_DATA_DIR=$DATA_DIR
Environment=PORT=8000
Environment=COPILOT_REAL_DISABLED=1
Environment=COPILOT_TRANSLATE_ORDER=provider,mock
Environment=COPILOT_ASR_ORDER=provider
ExecStart=/opt/copilot-venv/bin/python /opt/copilot-app/webapp/server/run.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable copilot
systemctl start copilot

sleep 8
curl -s http://127.0.0.1:8000/api/health || echo "health not ready yet"
echo "=== copilot-user-data 完成 ==="
