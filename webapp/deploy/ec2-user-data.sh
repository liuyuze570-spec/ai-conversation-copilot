#!/bin/bash
# EC2 裸机部署启动脚本（user-data）：不打包 Docker，直接跑 Python 后端 + 前端构建。
# 设计目标：让「已部署 AWS 且可访问」用最少步骤、最少失败点达成。
# 全程自动：装工具 -> git clone -> pip 装后端 -> npm 构建前端 -> 跑 uvicorn。
set -x
exec > /var/log/copilot-user-data.log 2>&1

REGION="ap-southeast-2"
REPO_URL="https://github.com/liuyuze570-spec/ai-conversation-copilot.git"

# ---------- 1. 基础工具 ----------
yum update -y
yum install -y git python3 python3-pip nodejs npm

# ---------- 2. 拉代码 ----------
cd /opt
rm -rf copilot-app
git clone --depth 1 "$REPO_URL" copilot-app
cd copilot-app/webapp

# ---------- 3. 装后端依赖 ----------
pip3 install --upgrade pip
pip3 install -r server/requirements.txt

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
ExecStart=/usr/bin/python3 /opt/copilot-app/webapp/server/run.py
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
