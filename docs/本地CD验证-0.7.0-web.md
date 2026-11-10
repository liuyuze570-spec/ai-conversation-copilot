# 本地 CD 验证（本地镜像 AWS，不碰真账号）

本目录用 Docker 在本地把「构建镜像 → 起服务 → 健康检查 → 反馈持久化 → 重启不丢」这条
CD 链验证一遍，等价于「本地镜像 AWS」那一档能做的事。**不创建任何 AWS 资源、不产生费用。**

## 为什么不是真正的 LocalStack

LocalStack 社区版的 ECS 支持有限（ECS 是 Pro 功能），用它模拟 ECS Fargate 会得到
「模拟器自己的坑」而不是「部署流程的坑」。所以这里用**标准 Docker** 做等价的本地验证：
Dockerfile 里的约定（非 root、健康检查、`COPILOT_DATA_DIR=/app/data`、`--proxy-headers`）
与将来上 AWS 完全一致，命名卷（named volume）就是 EFS 在本地的最小等价物。

真正上「在线 AWS」时，把这里的 named volume 换成 ECS 任务定义里的 EFS mountPoint 即可，
见 `docs/网站AWS部署方案-0.7.0-web.md` 第 3 节。

## 前置

- Docker Desktop 已启动（守护进程就绪：`docker info` 不报错）。
- 本机有模型文件（`webapp/server/models` 与 `webapp/mt/models`），
  否则只能用降级镜像（`Dockerfile.degraded`，health 里 real=false）。

## 步骤（在项目根目录执行）

```bash
# 1. 构建前端产物（web/dist 不进 git，必须先 build）
cd webapp/web && npm run build && cd ../..

# 2. 构建完整镜像（含模型；本机有模型时）
docker build -t copilot-web:0.7.0-web.11 -f webapp/deploy/Dockerfile webapp

# 3. 起服务（用命名卷承载反馈库）
docker compose -f webapp/deploy/docker-compose.yml up -d

# 4. 健康检查
curl -s http://127.0.0.1:8000/api/health
# 期望 real.translate=true、real.transcribe=true（完整镜像）

# 5. 提交一条反馈 → 拿到编号 + 凭证
# 6. 重启服务，验证反馈仍在（这是 CD 的关键验收）
docker compose -f webapp/deploy/docker-compose.yml restart
# 7. 用同一编号 + 凭证再查，确认没丢
```

## 自动化脚本

`scripts/verify-local-cd.sh` 会串起「构建 → 起服务 → 健康 → 写反馈 → 重启 → 查反馈」
并打印每一步 PASS/FAIL。运行：

```bash
bash scripts/verify-local-cd.sh
```

## 诚实边界

- 这条链证明的是「**本地 Docker 部署流程**」：依赖装得上、8 个模块拷得齐、
  uvicorn 起得来、健康检查通、命名卷能跨 `restart` 保留反馈。
- 它**不**证明：ECS Fargate 冷启动、ALB 健康检查、EFS 跨**重新部署**（非 restart）保留、
  HTTPS 证书、IAM 权限。这些要真云才能验。
- 「跨重新部署反馈不丢」在 WorkBuddy Sites 上已实测**不通过**；本地 named volume 能保留
  是因为卷不在源码目录里，而 Sites 上传会覆盖源码目录里的 sqlite。上 AWS 用 EFS 是正解，
  但**尚未实测**。
