#!/usr/bin/env bash
# 本地 CD 验证：构建镜像 → 起服务 → 健康检查 → 写反馈 → 重启 → 查反馈
# 只跑本地 Docker，不碰 AWS、不产生费用。详见 docs/本地CD验证-0.7.0-web.md
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f webapp/deploy/docker-compose.yml"
BASE="http://127.0.0.1:8000"
PASS=0; FAIL=0

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
ok()  { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }

cd "$ROOT" || exit 1

say "前置检查：docker 可用"
if docker info >/dev/null 2>&1; then ok "docker 守护进程就绪"; else bad "docker 守护进程未运行，先启动 Docker Desktop"; exit 1; fi

say "1. 构建前端产物"
# 旧 dist 存在不能冒充本次构建成功：先删掉再 build，退出码非零即失败。
rm -rf webapp/web/dist
( cd webapp/web && npm run build >/dev/null 2>&1 )
BUILD_RC=$?
if [ "$BUILD_RC" -eq 0 ] && [ -f webapp/web/dist/index.html ]; then
  ok "前端构建成功（本次产物，非旧 dist）"
else
  bad "前端构建失败（退出码 $BUILD_RC，或产物未生成）"
  exit 1
fi

say "2. 构建镜像（降级版，CI 同等路径；本机有模型可改用 Dockerfile）"
if [ -d webapp/server/models/faster-whisper-base ] && [ -d webapp/mt/models/Xenova/opus-mt-en-zh ]; then
  DOCKERFILE="webapp/deploy/Dockerfile"
  say "   检测到模型，构建完整镜像"
else
  DOCKERFILE="webapp/deploy/Dockerfile.degraded"
  say "   无模型，构建降级镜像（health 里 real=false 属预期）"
fi
docker build -t copilot-web:verify -f "$DOCKERFILE" webapp >/tmp/cd-build.log 2>&1
if [ $? -eq 0 ]; then ok "镜像构建成功"; else bad "镜像构建失败，见 /tmp/cd-build.log"; tail -20 /tmp/cd-build.log; exit 1; fi

say "3. 起服务（命名卷承载反馈库）"
# 直接用 docker run，避免 compose 里的 image tag 与本次构建不一致
docker rm -f copilot-verify >/dev/null 2>&1
docker volume rm copilot-feedback-verify >/dev/null 2>&1
docker run -d --name copilot-verify -p 8000:8000 \
  -e COPILOT_DATA_DIR=/app/data \
  -v copilot-feedback-verify:/app/data \
  copilot-web:verify >/dev/null 2>&1
ok "容器已启动（copilot-verify）"

say "4. 等健康检查通过"
READY=0
for i in $(seq 1 30); do
  if curl -sf "$BASE/api/health" >/tmp/cd-health.json 2>/dev/null; then READY=1; break; fi
  sleep 2
done
if [ "$READY" = 1 ]; then
  ok "health 200"
  # 纯 bash 解析，避开 Windows 下 python/node 读不到 Git Bash /tmp 的路径隔离
  HJSON="$(cat /tmp/cd-health.json 2>/dev/null)"
  HVERSION="$(printf '%s' "$HJSON" | grep -o '"version"[^,]*' | head -1)"
  HTRANS="$(printf '%s' "$HJSON" | grep -o '"translate"[^,}]*' | head -1)"
  HWHIS="$(printf '%s' "$HJSON" | grep -o '"transcribe"[^,}]*' | head -1)"
  echo "      $HVERSION | real.$HTRANS | real.$HWHIS"
  if printf '%s' "$HJSON" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then ok "health.ok = true"; else bad "health.ok 不为 true"; fi
else
  bad "health 超时未通过"
fi

say "5. 建会话 + 提交一条反馈"
SESSION="$(curl -sf -X POST "$BASE/api/session" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"token"[[:space:]]*:[[:space:]]*"//; s/"$//')"
HDR=()
[ -n "$SESSION" ] && HDR=(-H "X-Session-Id: $SESSION")
# 契约：category 必须是 recognition/translation/money_date/reply/pronunciation/operation/other 之一；
# where_wrong 与 suggestion 至少一个非空，否则 400 FEEDBACK_EMPTY。返回 {ok,ticket,token}。
RESP=$(curl -s -o /tmp/cd-fb.json -w "%{http_code}" -X POST "$BASE/api/feedback" \
  -H 'Content-Type: application/json' "${HDR[@]}" \
  -d '{"category":"translation","where_wrong":"本地CD验证","suggestion":"验证反馈跨重启持久化"}')
if [ "$RESP" = "200" ]; then
  FBJSON="$(cat /tmp/cd-fb.json 2>/dev/null)"
  TICKET="$(printf '%s' "$FBJSON" | grep -o '"ticket"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"ticket"[[:space:]]*:[[:space:]]*"//; s/"$//')"
  TOKEN="$(printf '%s' "$FBJSON" | grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"token"[[:space:]]*:[[:space:]]*"//; s/"$//')"
  if [ -n "$TICKET" ] && [ -n "$TOKEN" ]; then
    ok "反馈已写入，编号 $TICKET"
  else
    # 反馈接口 200 但拿不到编号/凭证 = 契约没兑现，不能当通过。
    bad "反馈接口 200 但未返回编号/查询凭证（见 /tmp/cd-fb.json）"
  fi
else
  # 反馈失败是必需步骤：如实标 FAIL，不跳过、不显示全绿。
  bad "反馈提交失败（HTTP $RESP，见 /tmp/cd-fb.json）"
  TICKET=""
  TOKEN=""
fi

say "6. 重启容器"
docker restart copilot-verify >/dev/null 2>&1
sleep 5
if curl -sf "$BASE/api/health" >/dev/null 2>&1; then ok "重启后 health 仍 200"; else bad "重启后 health 未恢复"; fi

say "7. 验证反馈跨重启仍在"
if [ -n "$TICKET" ] && [ -n "$TOKEN" ]; then
  QRESP=$(curl -s -o /tmp/cd-q.json -w "%{http_code}" "$BASE/api/feedback/$TICKET" -H "x-feedback-token: $TOKEN")
  if [ "$QRESP" = "200" ]; then ok "反馈编号 $TICKET 重启后仍可查"; else bad "反馈查询返回 $QRESP（跨重启持久化未通过）"; fi
else
  # 上一步没拿到编号/凭证，这一步无法断言 → 如实标 FAIL，不跳过。
  bad "无反馈编号/凭证，跨重启持久化无法验证"
fi

say "收尾：停容器"
docker rm -f copilot-verify >/dev/null 2>&1
docker volume rm copilot-feedback-verify >/dev/null 2>&1
ok "已清理"

printf '\n\033[1m合计 %d 通过 / %d 失败\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
