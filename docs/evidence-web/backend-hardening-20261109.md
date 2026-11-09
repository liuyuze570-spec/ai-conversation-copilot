# 后端加固证据（2026-11-09）

> 范围：只改后端 Python、Dockerfile / 部署配置与 `webapp/web/src/api.ts` 的反馈查询一处。
> 未碰 `src/`、其它前端文件、`docs/` 其它文件、发布副本 `F:/copilot-deploy/app/run.py`；
> 未运行 `npm build`、未发布网站、未 git 提交。
> 全部数据为本轮真实运行所得；不把「配置存在」写成「运行通过」，不编造测试结果。
> 测试与脚本一律用合成数据，不读任何真实用户数据 / Key / 录音。

环境：`webapp/server/.venv/Scripts/python.exe` = Python 3.12.14；系统 `python` = 3.13.14。
工作目录：`f:/3D打印Rhino 7.0/2026-09-30-23-01-15`。

---

## 0. 本轮改动文件

**修改**
| 文件 | 用途 |
|---|---|
| `webapp/server/app.py` | 问题 1/2/3/5：日志前移、会话候选逐一验证、反馈限流与体积上限、查询凭证读请求头 |
| `webapp/web/src/api.ts` | 问题 5：`queryFeedback` 改用 `x-feedback-token` 请求头（仅此一处） |
| `webapp/deploy/Dockerfile` | 问题 6：COPY 全部运行时模块、`COPILOT_DATA_DIR`、`VOLUME`、`--no-access-log` |
| `webapp/deploy/README.md` | 问题 4/5：环境变量、旧 query 废弃、持久性限制说明 |
| `webapp/.dockerignore` | 问题 7：排除 `server/data`、测试/离线脚本，不再整目录排除 `deploy` |

**新建**
| 文件 | 用途 |
|---|---|
| `webapp/server/run.py` | 问题 5：源码启动入口，`access_log=False`（发布副本按要求未改） |
| `webapp/deploy/backup_restore_feedback.py` | 问题 4：发布前备份 / 发布后恢复，纯文件复制 + sha256 |
| `webapp/deploy/docker-compose.yml` | 问题 7：最小配置，命名卷挂 `/app/data` |
| `webapp/server/test_backend_hardening.py` | 14 个回归测试 |
| `docs/evidence-web/backend-hardening-20261109.md` | 本文件 |

**核对后未改动**：`webapp/server/requirements.txt`（运行时模块第三方依赖仅
`fastapi / pydantic / starlette / httpx / numpy`，均已在列，无新增）；
`webapp/server/feedback_store.py`（`__init__` 已支持任意外部 `Path` 并自动建父目录，
由测试 12/13 验证）；`webapp/web/src/FeedbackPanel.tsx`（通过 `queryFeedback` 调用，不直接拼 URL）。

---

## 1. 会话凭据优先级（问题 1）

现状复现：`session_id_from()` 只要 `sid` Cookie 非空就返回，`require_session` 只查这一个值，
「无效 Cookie + 有效 `X-Session-Id`」被判 `unknown` / 403。

修复：`session_candidates()` 收集 Cookie 与请求头两个候选（去重），
`session_from()` 逐一 `STORE.lookup()`，取第一个「服务端认识且未过期」的会话；
`require_session()` 改用它。两张凭据查同一张会话表、同一份 `SESSION_TTL`，未放宽鉴权；
403 仍带 `recoverable=True`，前端 `withSession` 一次重建重试逻辑未改动。

真实输出（综合探针）：
```
SESSION_FROM valid= True reason= '' matches= True
```
端到端 `POST /api/translate`（无效 Cookie + 有效 header，空白文本）返回 **400** 而非 403，
证明鉴权通过；无有效凭据的对照用例返回 **403**。测试 04 验证 `SESSION_TTL == 7200` 且过期返回 `expired`。

## 2. 反馈提交限流 / 体积 / DB 失败（问题 2）

现状复现：`feedback_submit` 未调用 `STORE.rate_ok()`，`_feedback_session_key` 用未验证的 sid。

修复：
- `Store.feedback_rate_ok(key)`：按「已验证会话 sid / 来源 IP」哈希独立计数，
  阈值 `COPILOT_FEEDBACK_RATE_PER_MIN`（默认 5）；被挡的请求**不进入** `FEEDBACK.submit()`。
- 请求体上限 `COPILOT_FEEDBACK_MAX_BODY_BYTES`（默认 65536）：先查 `Content-Length`，
  再按各文本字段 UTF-8 字节合计兜底（覆盖无长度头的 chunked 请求）。
- `FEEDBACK is None` 与 `submit()` 运行期异常都返回 **503** `FEEDBACK_STORE_UNAVAILABLE`，
  绝不返回带 `ticket` 的伪造回执。

真实输出（测试 05 / 06 / 07 的日志片段）：
```
feedback-created ticket=... status=200
feedback-created ticket=... status=200
req ... path=/api/feedback status=429
req ... path=/api/feedback status=413
req ... path=/api/feedback status=503
```
测试 05 断言 `statuses == [200, 200, 429]` 且 `FEEDBACK.count() == 2`
（被限流的第 3 条确实没有入库）。综合探针：`FEEDBACK_RATE_PER_MIN= 5 MAX_BODY= 65536`。

> 设计取舍（如实说明）：未对 `/api/feedback` 强制 `require_session()` 阻断提交。
> 原因是前端 `submitFeedback` 未包 `withSession`，而本轮只允许改 `api.ts` 的查询一处；
> 一旦强制，失效会话时提交会 403 且前端不会自动重建重试。现改为把**已验证会话**
> 作为限流/去重键、无有效会话时按 IP 兜底（同样受限流约束），既堵住「随手编 sid
> 绕过去重」又不破坏现有前端。若需彻底收紧，需同时给 `submitFeedback` 加重试，超出本轮授权范围。

## 3. 反馈库初始化 LOG NameError（问题 3）

复现（修复前，令 `COPILOT_DATA_DIR` 指向一个普通文件）：
```
IMPORT_FAILED NameError name 'LOG' is not defined
```
修复：把 `logging.basicConfig(...)` 与 `LOG = logging.getLogger("copilot")` 移到
`FeedbackStore(...)` 初始化之前。修复后同一场景：
```
{"level":"WARNING","msg":"feedback-store-unavailable type=FileExistsError"}
IMPORT_OK FEEDBACK= None
```
子进程测试 10 进一步验证：`import app` 成功、`/api/health` 返回 **200**、
`POST /api/feedback` 返回 **503**（`UNAVAILABLE_OK 200 503`）。

## 4. 反馈库持久化 / 备份恢复（问题 4）

`app.py` 原有 `COPILOT_DATA_DIR`（默认 `server/data`）保持不变，Dockerfile 内设为 `/app/data`
并声明 `VOLUME`，compose 挂命名卷。新增 `deploy/backup_restore_feedback.py`：
`backup` / `restore` 两个子命令，纯 `shutil.copy2` + sha256 sidecar 校验，
覆盖前把现有库另存，不连任何线上数据库。

真实往返（本轮单独跑一次，非测试内输出）：
```
SEEDED_TICKET FB-20261109-A0FAA2
[backup] OK ...\data\feedback.sqlite3 -> ...\backup\feedback-20261109-203952.sqlite3 sha256=13bb736c084f9c795ba779818c50295a7e314f05a7cdd5bf51b0db552ad9ad41 bytes=16384
RC 0
[restore] OK ...\backup\feedback-20261109-203952.sqlite3 -> ...\data\feedback.sqlite3 bytes=16384
RC 0
ROWS_AFTER_RESTORE 1
TICKET_STILL_QUERYABLE True
ROUNDTRIP_EXIT 0
```
测试 11 验证 `COPILOT_DATA_DIR` 生效（`FEEDBACK.path.resolve().parent` 等于环境变量目录）；
测试 12 验证 `FeedbackStore` 接受任意外部嵌套路径；测试 13 验证重开库后原编号可查；
测试 14 把 backup→删库→restore→重开查编号串起来。

> **需平台持久目录或外置 DB 才能真正跨部署**：平台是否有持久卷未知。若
> `COPILOT_DATA_DIR` 指向随发布被覆盖的临时目录，备份文件必须保存在发布流程之外、
> 且把 restore 接进发布流程才有意义；只把库文件复制进镜像 / 发布目录，下一次发布仍会覆盖。
> 脚本 docstring 与 `deploy/README.md` 第 8 节均如实写明，**不把本地文件复制冒充线上已验证**。

## 5. 查询凭据移出 URL（问题 5）

- 前端 `api.ts` 的 `queryFeedback`：改用 `headers: { 'x-feedback-token': token }`，
  URL 只剩 `/api/feedback/{ticket}`；`FeedbackPanel.tsx` 不拼 URL，无需改动。
- 后端 `feedback_lookup`：优先读 `x-feedback-token` 请求头，`?token=` 仅作**短期兼容**
  并在路由 docstring 与 `deploy/README.md` 标注 **DEPRECATED**；CORS `allow_headers` 增加
  `x-feedback-token`。
- 关闭 access_log：`Dockerfile` CMD 加 `--no-access-log`；源码 `webapp/server/run.py`
  设 `access_log=False`。`app.py` 的 `RequestIdMiddleware` 本就只记 `request.url.path`，
  不含 query。发布副本 `F:/copilot-deploy/app/run.py` **按要求未改**。

真实输出（综合探针 / 测试 08）：
```
LOOKUP header= 200 legacy_query= 200 none= 403
```
前端残留检查：`grep "URLSearchParams|\?token|token=\$\{|/api/feedback/" webapp/web/src`
只剩注释与 `config` / 无 query 的 `/api/feedback/{ticket}`，无 URL 拼接 token。

## 6. Dockerfile 漏 COPY（问题 6）

旧版只 COPY 5 个模块，漏 `engine_mt_multi.py` / `phrasebook.py` / `feedback_store.py`，
隔离环境 `import app` 会 `ModuleNotFoundError: No module named 'engine_mt_multi'`。

新版显式 COPY 9 个运行时 py（8 个 `app.py` 顶层 import 的本地模块 + `run.py`），
不含测试 / testdata / 离线脚本；声明 `COPILOT_DATA_DIR=/app/data` + `VOLUME ["/app/data"]`，
保留原 HEALTHCHECK，CMD 加 `--no-access-log`。

模型 / 前端路径核对（真实检查，全部 `exists= True`）：
```
OK       server/models/faster-whisper-base  -> COPILOT_WHISPER_DIR
OK       mt/models/Xenova/opus-mt-en-zh     -> COPILOT_MT_MODEL_DIR
OK       web/dist/index.html                -> COPILOT_WEB_DIST
```

静态校验（按 Dockerfile 的 COPY 清单在临时目录重建文件集合，再 `python -c "import app"`）：
```
COPY_LIST: ['server/app.py', 'server/engine_asr.py', 'server/engine_mt.py', 'server/engine_mt_multi.py', 'server/engine_mt_onnx.py', 'server/engine_reply.py', 'server/phrasebook.py', 'server/feedback_store.py', 'server/run.py']
COPIED: 9 个文件全部存在
IMPORT_STDOUT: STATIC_IMPORT_OK 0.7.0-web.10
IMPORT_RC: 0
STATIC_CHECK_EXIT=0
```
隔离目录里只有这 9 个文件仍能 `import app` 成功，证明清单已覆盖全部运行时依赖。

## 7. compose / .dockerignore / requirements（问题 7）

- 原本没有 `docker-compose*.yml`：补 `webapp/deploy/docker-compose.yml`（`context: ..`、
  `COPILOT_DATA_DIR=/app/data`、命名卷 `copilot-feedback:/app/data`、`8000:8000`）。
- `.dockerignore`：补 `server/data`、`server/test_*.py`、`server/offline_*.py`、
  `compare_models.py` / `run_offline.py` / `_tts_offline.py` / `**/*.sqlite3`；
  去掉整目录 `deploy` 排除，避免 `-f deploy/Dockerfile` 读不到 Dockerfile。
- `requirements.txt`：核对运行时模块的第三方 import 后确认无新增依赖，**未改动**。

---

## 8. 测试（真实命令与输出）

命令均在项目 `webapp/server` 下、用 `.venv/Scripts/python.exe` 执行。

**（1）本轮新增回归测试**
```
$ ./.venv/Scripts/python.exe -m unittest test_backend_hardening -v
Ran 14 tests in 4.302s
OK
```
14 通过 / 0 失败。用例与覆盖：
- 01 失效 Cookie + 有效 header 命中有效凭据（问题 1）
- 02 端到端：无效 Cookie + 有效 header 返回 400 而非 403（问题 1）
- 03 无有效凭据仍 403 + recoverable（问题 1，鉴权未放宽）
- 04 `SESSION_TTL == 7200` 且过期返回 expired（问题 1）
- 05 限流 `[200,200,429]` 且 `count()==2`（问题 2）
- 06 请求体超限 413 且库无新增（问题 2）
- 07 库不可用 503 且无 `ticket`（问题 2）
- 08 `x-feedback-token` 头 200 + 旧 `?token=` 200（问题 5）
- 09 无凭证 / 错凭证 403（问题 5）
- 10 目录不可用：`import app` 成功、health 200、反馈 503（问题 3）
- 11 `COPILOT_DATA_DIR` 生效（问题 4）
- 12 `FeedbackStore` 外部路径（问题 4）
- 13 重开库后原编号可查（问题 4）
- 14 备份→删库→恢复→重开查编号（问题 4）

**（2）现有测试回归**
```
$ ./.venv/Scripts/python.exe -m unittest test_feedback test_capture test_phrasebook
Ran 33 tests in 0.292s
OK
```
33 通过 / 0 失败。

**合计：47 个测试通过，0 失败，0 错误，0 跳过。**

---

## 9. Docker 状态（如实：未真实构建）

本机有 `docker` 命令，但守护进程未运行：

```
$ command -v docker
/c/Program Files/Docker/Docker/resources/bin/docker

$ docker version            # 只返回客户端
Client: Version 29.6.1, API version 1.55, OS/Arch windows/amd64

$ docker info --format '{{.ServerVersion}}'
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running:
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.

$ cd webapp && docker build -f deploy/Dockerfile -t copilot-web:hardening-20261109 .
ERROR: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine;
check if the path is correct and if the daemon is running:
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
BUILD_EXIT=1
```

**结论：未真实构建、未启动容器、没有镜像 ID，也没有在容器里跑 `/api/health` 或
`/api/feedback/config`。** 原因是 Docker Desktop 守护进程未启动（`dockerDesktopLinuxEngine`
管道不存在），不是 Dockerfile 语法错误。未假装容器验收完成。

替代验证：上文第 6 节的**静态校验通过**（按 COPY 清单重建 9 个文件、隔离
`import app` 成功、模型/dist 三条路径核对存在）。这是文件集合与导入层面的验证，
**不等价于**真实镜像构建与容器运行验收。

---

## 10. 未解决问题 / 未验证项（如实列出）

1. **Docker 容器验收未完成**：守护进程未运行，需在 Docker Desktop 启动后补做
   `docker build -f deploy/Dockerfile -t copilot-web:... .` 并 `docker run` 实测
   `/api/health`、`/api/feedback/config`。本轮只有静态校验。
2. **线上前端仍是旧的 dist**：按要求未运行 `npm build`，`webapp/web/dist` 未重新生成。
   `api.ts` 的改动要重新构建 dist 才会在托管页面生效；当前线上前端仍会把 token 放在
   URL query 里（后端保留了 query 兼容，功能不坏，但「凭据不进 URL」的安全目标在
   **线上前端**尚未真正落地）。
3. **发布副本 `F:/copilot-deploy/app/run.py` 未改 access_log**：按要求未碰发布目录；
   下次重新发布需用 `webapp/server/run.py` 覆盖发布根 run.py，否则该入口仍开默认访问日志。
4. **平台持久卷未知**：`COPILOT_DATA_DIR` + `VOLUME` + 备份/恢复脚本只是机制；
   **需平台持久目录或外置 DB 才能真正跨部署**。本轮没有在任何真实部署上验证
   「发布前编号、发布后仍可查」，也不拿本地文件复制冒充线上已验证。
5. **旧 `?token=` 兼容仍在**：短期保留，已标注 DEPRECATED；若有人仍用旧 URL，
   代理 / 浏览器历史仍可能记录凭证，需要后续版本移除。
6. **反馈提交未强制有效会话鉴权**：见第 2 节的设计取舍，需要前端配合加一次
   `withSession` 重试才能在不破坏体验的前提下收紧。
7. 未运行 `test_mt_onnx.py`（模型相关，与本轮改动无关），未做前端 TypeScript 编译
   （按要求不跑 `npm build`），未 git 提交、未发布网站。
