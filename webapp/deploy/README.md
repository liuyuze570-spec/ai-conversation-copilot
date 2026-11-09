# 网页版部署与运行（版本 0.7.0-web.1）

一个进程同时提供网页和接口：**没有 Node 运行时**，翻译是进程内 ONNX 推理，
识别是本机 faster-whisper。镜像里不含 `node_modules`、`.venv`、测试音频。

---

## 1. 现在是什么状态

| 项目 | 状态 | 依据 |
|---|---|---|
| 本地起服务、网页 + 翻译 + 识别全通 | **已实测** | 见 `docs/网站测试报告-0.7.0-web.md` |
| 精简发布目录（256MB）能独立跑 | **已实测** | 从 `/f/copilot-release/web-0.7.0` 启动，首页 200、翻译 615ms、识别 419ms |
| `Dockerfile` | **已写好，未构建** | 本机 Docker Desktop 未运行，`docker info` 连不上守护进程 |
| 公网 HTTPS 地址 | **已上线** | WorkBuddy Sites 发布：`https://en-zh-caption-helper.app.workbuddy.host/?sharecode=X3A6YY6GQH`；2026-11-09 10:07 重新发布（含数词与中文确认句修复），首页 200 / health 200 / 真实翻译 809ms |
| GitHub Actions | **只准备了工作流文件，未跑过** | 不能写成「CI/CD 已完成」 |

---

## 2. 本机直接跑（已验证）

```bash
cd webapp/server
NO_PROXY=127.0.0.1,localhost \
COPILOT_WHISPER_DIR="$PWD/models/faster-whisper-base" \
./.venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

打开 http://127.0.0.1:8000 。`/api/health` 里 `mode.translate` 应为 `local-onnx`、
`mode.transcribe` 应为 `local-whisper`，`real` 两项为 `true`。

> 环境里有 `http_proxy`，访问本机地址必须加 `NO_PROXY=127.0.0.1,localhost`，
> 否则 httpx/curl 会把 127.0.0.1 也发给代理，报 `os error 10061`。

前端改动后要重新构建，否则服务端托管的是旧 dist：

```bash
cd webapp/web && npm run build     # tsc --noEmit && vite build
```

---

## 3. 构建镜像

```bash
cd webapp
python deploy/fetch_models.py --check          # 模型摘要不对就别继续
docker build -f deploy/Dockerfile -t copilot-web:0.7.0-web.1 .
docker run --rm -p 8000:8000 copilot-web:0.7.0-web.1
```

构建上下文是 `webapp/`，`.dockerignore` 已排掉 `mt/node_modules`(676MB)、
`server/.venv`(371MB)、测试音频和前端源码。

模型在**构建时**进镜像，运行时不联网下载（`local_files_only`）。
`fetch_models.py` 按 **sha256** 锁版本，不按分支名；`--download` 只在准备阶段用，
默认走 `hf-mirror.com`。

---

## 4. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `COPILOT_REAL_DISABLED` | 未设 | `=1` 时所有真实调用关掉，只返回预置结果（应急开关） |
| `COPILOT_TRANSLATE_ORDER` | `local-onnx,provider,mock` | 翻译优先级；可写 `local-opus` 用 Node 边车对照 |
| `COPILOT_MT_MODEL_DIR` | `webapp/mt/models/Xenova/opus-mt-en-zh` | 本地翻译模型 |
| `COPILOT_WHISPER_DIR` | 未设 | 本地识别模型；不设则识别降级 |
| `COPILOT_LLM_BASE_URL` / `_API_KEY` / `_MODEL` | 未设 | 云端文字模型（OpenAI 兼容）。**只在服务端** |
| `COPILOT_STT_BASE_URL` / `_API_KEY` | 未设 | 云端语音识别 |
| `COPILOT_ALLOW_ORIGINS` | 未设 | 只有显式配了才开 CORS；不配则同源 |
| `COPILOT_QUOTA_TRANSLATE` / `_TRANSCRIBE` | 40 / 10 | 每个访客会话的配额 |
| `COPILOT_MAX_CHARS` / `_MAX_AUDIO_MB` / `_MAX_AUDIO_SECONDS` | 2000 / 8 / 60 | 输入上限 |

默认配置**不需要任何 Key 就能跑通翻译和识别**，这是当前唯一实测过的真实路径。

---

## 5. AWS 最小费用方案（**已不需要：改用 WorkBuddy Sites 发布**）

公网地址已经通过 WorkBuddy Sites 拿到（见第 1 节表格），不需要 AWS 账号，
也没有 `aws` CLI 或凭据。下面这段方案留着备查，**没有创建任何资源，没有产生任何费用**。

| 方案 | 适用 | 近似费用（须以官网当期价为准） | 代价 |
|---|---|---|---|
| **A. Lambda 容器 + API Gateway**（推荐先试） | 文字链路，用量小 | 免费额度内约 0；超出后按 GB-s 计 | 冷启动要加载 257MB 模型，首个请求 5–10s；响应上限 15 分钟 |
| B. App Runner / ECS Fargate 常驻 | 音频也要快 | 约 $5–15/月 | 一直计费，不跑也在花钱 |
| C. EC2 t4g.small 自管 | 想完全可控 | 约 $12/月 | 要自己配反代、证书、重启策略 |

推荐 A：我们的请求是「2GB × 约 1 秒 ≈ 2 GB-s」，免费额度（每月 40 万 GB-s）
可以覆盖十几万次翻译，演示和小规模试用基本不花钱。若音频识别必须秒回，再讨论 B。

**需要你提供/确认的：**

1. AWS 账号凭据（或一个能部署的 IAM 角色）与目标区域；
2. 是否接受上面 A 方案的费用范围；
3. 域名：**不要买**。先用 AWS 给的默认域名 + 免费证书；确有需要再单独说；
4. 谁来点「发布」这一步（我这边没有对外发布授权）。

有凭据后我会做：构建并推镜像 → 部署 → 用**另一台设备/另一网络**打开 HTTPS 地址
验证文字链路 → 记录版本号与回滚命令 → 再把地址写进交付材料。

---

## 6. 回滚

镜像部署：把服务指向上一版 tag 即可（`copilot-web:<上一个版本>`），无需改数据库
（本服务不写数据库，会话在内存里，重启即清空）。

版本号在 `/api/health` 的 `version` 字段，回滚前后各取一次做对照。

---

## 7. 已知限制（别当成 bug）

- 识别只支持**录音后识别**，不是边说边出字幕；单段上限 60 秒。
- 网页端**不保存**音频与对话（不写 localStorage），刷新即失。
- 只有同源部署实测过；跨域要显式配 `COPILOT_ALLOW_ORIGINS`。
- 只测过 Chrome（桌面 1280 宽、手机 390 宽）。Safari 的 `audio/mp4` 未验证。
- 麦克风真机授权在 HTTPS 下才成立；`http://` 或非 localhost 会被浏览器直接拒。
