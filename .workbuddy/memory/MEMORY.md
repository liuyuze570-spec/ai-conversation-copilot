# AI Conversation Copilot（0.6.2：听障使用者的跨语言沟通助手）
Electron 33.2.1 + React18 + TS5.6 + Vite5 + Tailwind3.4 + Zustand5；460×640 悬浮窗；Python WASAPI 回环 sidecar；node-sqlite3-wasm（WAL 不生效，用 delete 回滚日志）。
源码 `F:/3D打印Rhino 7.0/2026-09-30-23-01-15`（0.6.2）；用户数据 `%APPDATA%/ai-conversation-copilot`；B 盘安装版 **0.6.1**（2026-11-07 读 asar 内 package.json；exe 文件版本 33.2.1 是 Electron 运行时），只读不改。
用户偏好：中文；直接改代码并跑验证；回复要能说出口；不自动回复（Alt+Space）；隐私优先；只写跑过的数字。

## 语言方向（shared/languages.ts）
四元组：uiLanguage(zh-CN) / nativeLanguage / targetLanguage / hintSystem(hanzi|katakana|romaji|none) / accent；不按国籍推断。
只实测 zh→en(hanzi)、ja→en(katakana)、en→ja(romaji)，其余标 structured 不标「已支持」。
HintPlan/HintSegment：id=`${from}-${to}`（原文 UTF-16 范围），原文改即失效；HINT_VERSION=2 进缓存键；提示从**最终原文**算。
settings-store：`provided` 集合区分「没设过」与「默认值」；readingVersion 一次性闸门（DEFAULT_SETTINGS 不能给默认值）。

## 确认句必须与当前理解一致（0.6.2 核心）
FactItem 增 `spoken` / `spokenSource: user|derived` / `negated / edited / originalValue / confirmedAt / log`。
`deriveSpoken(fact,target)` 算「现在该怎么说」：未改用原话；改过则在原话结构上换时间点/星期/数值；换币种/换地点/推不出→`blocked`。**不在原话上改写的句子不许用。**
`planConfirmSentence(facts,target,comprehension)` → `{ok,sentence,meaning,blocked,message}`；模型路径再走 `checkSentenceAgainstFacts`（按 `valueNumbers()` 比数值、按星期比，改后值必须在、改前值不许在）。
**坑**：过滤只排 `negated`，不能顺手排 `certainty==='corrected'`（模型把更正后的值标 corrected，那正是要确认的内容）。
`joinTail()` 防 `p.m.` + `. Is that right?` 叠成 `p.m..`。
factsStore.version：任何影响确认句的改动 +1，在途请求回来版本不符即丢；改值→回 pending、清 confirmedAt、补 unconfirmed 轨迹、作废旧草稿。
事实卡保存状态独立（factSaveState / factSaveError），不许被字幕的「已保存」掩盖。

## 记录（SQLite，schema v3）
分页游标用 `seq`；getPage({beforeSeq}) LIMIT n+1；加载后两帧 rAF 钉滚动。
同一 id ON CONFLICT 覆盖，空值不覆盖非空；`cleared` 白名单区分「没给」与「明确清空」。
history-sync 是唯一写入者；写队列串行；pendingReply 只在成功回执后清；失败不清场。
v3：facts 加 11 列（source_field/negated/original_value/status/confirmed_at/log/spoken/spoken_source/comprehension/target_language/hint_system），只 ADD COLUMN；`removedIds` 真删；`from>SCHEMA_VERSION` 只记「schema 更新」警告继续用旧列。
备份用 VACUUM INTO，不许 copyFile 正在写的库；备份不含 settings.json（Key 与个人词表在那儿）。

## 音频/安全不变量
sourceMode 进 pipelineSignature；engineGeneration 封闭包，不符先 stop 再清；每流只死一次；TRANSCRIBE_DEADLINE 25s + 队列上限 4。
Key 绑定 origin；公网强制 https；app.log 只记状态/错误码/字数，正文译文模型返回不许进；取消按 requestId 真 abort；TTS 语言不匹配报 TTS_LANG_UNAVAILABLE。
音源与理解语言在**字幕产生时**绑定（`currentSourceStamp()`），不按之后设置反推。

## 读音
status 三态 ok/approx/unknown；界面用文字「规则近似 N 段」+虚点线。缩写按字母名念（PDF→匹 迪 艾夫）、带点查 ABBREV_SOUNDS（p.m.→皮艾姆）+TITLE_WORDS；**Electron ICU ≠ Node ICU**（`p.m.` Chromium 切成 p+m）→ mergeDottedSpans 再查表，只有打包版自检能发现。
个人词表：存完用新词表重算当前句写回；旧历史留当时快照。

## 演示短句
`mock-translation.ts` 的 SHORT_PHRASES（14 条）走整句层：Tomorrow./Next week./See you tomorrow. → 明天。/下周。/明天见。
关键词兜底必须带「〔演示模式只认出关键词：…〕」，不把关键词拼接冒充整句翻译；没预置就明说，不拿中文顶替。

## UI/无障碍
禁止原生 select（controls.tsx 自绘）；面板 portal + `[data-app-shell].inert` + 手写 Tab 环 + Esc + 焦点归还；高对比真换底色；字号 12–64，三类独立。

## 环境坑
路径含中文 → 必须 `npm run dist:win`（ASCII 暂存）；disableHardwareAcceleration；生产走 `copilot://`；单实例锁会让自检静默失败 → `--user-data-dir`；自检要点真实按钮不能读 React disabled。打包前必须 `npm run build`。

## 验证（0.6.2 实测）
`npm run typecheck` 0 错；`npm run test:unit` **13 套 / 1045 条 / 0 失败**（competition192/reliability183/levels69/pron53/latency80/reply16/heal11/history126/reading45/hint79/tts23/samples90/confirm78）。
源码与打包版自检均 **13 步**、`"ok":false` 0 次、8 图（04/04b 才是双面卡两面）；跨进程 **24 项一致**；asar `ASAR_OK`、渲染 2/2、`stray: []`。
写自检时注意：**截图要在卡片开着时拍**，Esc 之后拍到的只是回复面板。

## 未完成/不得宣称
真实音频端到端（HTTP 402）、真实模型确认句、真实翻译质量、朗读出声（本机仅 zh 语音）、母语者读音核对（0 条）、听障使用者体验（0 人）、读屏实读、干净机安装、重装、代码签名、10 万条大库。
材料入口 `docs/交付说明-0.6.2.md`；其余 -v0.6.2：修复与验证/测试记录表/打包核对/数据存储与备份/目标使用者体验/路演材料-5页。

## 网站版（0.7.0-web.5，与桌面端并存）
线上 `https://en-zh-caption-helper.app.workbuddy.host/?sharecode=X3A6YY6GQH`（WorkBuddy Sites，`/api/*` 也要带 sharecode 或先拿 cookie）。
源码 `webapp/`：`web`(React+Vite，别名 `@shared`→`../../src/shared`) / `server`(FastAPI，进程内 ONNX Opus-MT + faster-whisper)。
**发布源目录是 `F:/copilot-deploy/app`，不是工程根目录**（平台排除构建产物）：`run.py`(自读 PORT) + `server/` + `web/app/` + `mt/models/` + `server/models/`。
`.wbapp_*.genie` 的 `localDir` 决定「目录→应用」，同一目录重发链接不变。线上 `reply=mock`（无 Key）。
共享层 `src/shared/numeric-check.ts`（数字/时间/日期/否定/方向一致性）与 `facts.ts`（事实卡+确认句）两端共用，改动必跑 `npm run test:unit`（15 套 / 1157 条）并重建前端。

### 翻译链路四条不变量（0.7.0-web.5）
1. **常用语库优先于模型**：`server/phrasebook.py`（391 句 + 248 词 + 75 条拼写变体，`hellow→hello`）命中即返 `mode="phrasebook"`；模型再强也不如查表确定。
2. **解码必须防退化**：`no_repeat_ngram_size=3`；步数 `max(24, enc_len*4.5+12)`；beam 提前 EOS 后每步按 `seq.shape[0]` 重排 hidden。**整行候选全被屏蔽时必须回退原 logits**，否则 `np.log(-inf)`→nan→argmax 落 EOS，短句被截断。
3. **每路都要过退化自检**：`looks_degenerate()`（空译/原样吐回/单字重复≥4/同词重复≥3/长度失控）不过就跳过该路，全失败才 `TRANSLATE_FAILED`(422)，不许拿垃圾译文顶。
4. **日韩俄只能两级转译**：Xenova 无 `opus-mt-{ja,ko,ru}-zh`（实测 404），走 `xx→en→zh`（`engine_mt_multi.CascadeMT`，`mode="local-cascade"`），中间英语回传 `via` 并在界面显示，不冒充直译。

读音：`src/services/pronunciation.ts` 的 `LANG_WORDS`（日/韩/俄）在规则之前命中；`WORD_SOUNDS` 补口语变体。
自动回复：翻译成功即静默出 3 条（repeat/confirm/ask），模板不许替用户答应；无 Key 必须标「人工模板句，不是 AI 生成」。
**发布必须显式 `startCmd="python run.py"`**，不传会跑 `main.py` → `SITES_START_FAILED`，原分享链接会短暂打不开（已踩两次）。
证据 `docs/evidence-web/compare30-web5.json`、`webapp/e2e/verify-online.mjs`（19 项），报告第 13 节。
实况：30/30 成功、中位 818ms，但只有 2 条译文变化——MQ10 凭空「美元」、NC04 丢否定、DT09 读错「改到」仍在，**整句事实保真没改善**。

### P0 事实保真四条不变量（0.7.0-web.7，A/B/C 三句已闭环）
1. **币种只看原话**：`currencyOf(originalText)`；原话没提 → 事实卡「币种未说明」，译文补的币种由 `strip_invented_currency` 剪掉并进 `corrections[]` 界面黄条点名——**只减不增，不悄悄替换**。
2. **改期是三张卡**：`role`=origin/current/duration；旧安排不进确认句；译文丢「改到」由 `express_reschedule` 补回。确认句模板 `…now X instead of Y…`。
3. **合并配对先对齐否定+role 再数值再顺序**：中文日期抽取顺序≠出现顺序，盲配会把否定标记串到当前值上（周四被划掉、周二当有效）。裸数字金额用**字符区间**排时间（`2 p.m.` 的 2 不是金额）。
4. **回复卡本地拼**（`reply-plan.ts`）：确认/澄清/礼貌 + 兜底「请对方打字」，翻译成功即出、不等模型；英文句只用 `labelEn`（中文类名「金额」漏进英文句实测发生过）；近音默认隐藏有开关；无 Key 时界面标「规则生成」。
测试：`.dev/p0-fidelity-unit.mjs` 35 条（A/B/C+变体，挂进 test:unit，现 16 套）+ `webapp/e2e/p0-verify.mjs` 真浏览器 24 项（本地/公网全 PASS）。报告第 14 节；官方赛题文件未找到（待核实）、讲述人实读与真实用户试用均 0。

### 0.7.0-web.8 四条不变量（P0 三修 + P1）
1. **英文句只用原话片段**：双语事实的 `value` 是中文展示值（450欧元），`sourceText` 才是原话（450 euros）。`reply-plan.englishAmount()` 把数字/币种/中文值三路分开；推不出数字宁可不生成确认句。
2. **数字近音不许静默省略**：`pronunciation.ts` 按英语读法转（300→斯瑞 汉卓德、4:20→佛 特温提、12.5→…泡因特 法伊夫）；句尾标点先剥；推不出返回 `〔数字读音未确定〕` 占位；`missingNumberHints()` 做界面第二道防线。
3. **大字卡焦点**：打开时记 `event.currentTarget`，弹层卸载统一 restoreFocus；触发按钮被卸载退到 `h1[data-focus-fallback]`。别把触发 ref 写死在某颗按钮上。
4. **反馈是真 SQLite 文件库**（`feedback_store.py`）：1000 字按 Unicode 码点前后端同源（config 下发）；编号+一次性凭证（只存 SHA-256）；状态只能由带 admin token 的 PATCH 推进，前端无入口 → 未配置时永远「已收到」。路由必须注册在 `/{path:path}` 之前。
主题：三套色靠 `body[data-theme]` + CSS 变量覆盖 Tailwind 类（作用域 `#root`）；跟随系统要在切到 system 时**重新读并校准** `systemPrefersDark()` 快照，否则 change 值相同被 React 跳过。
**版本纪律**：2026-11-09 15:41 已把公网从 web.7 一次性发布到 **`0.7.0-web.9`**（web.8 未单独上线）；发布前完整备份 `F:/copilot-deploy/backup-web8-20261109`（592MB，8899 从该目录继续跑 web.8）；`stable-web.9/.8/.7` 三个标签；发布必须显式 `startCmd="python run.py"`、版本号发布前必升、已有 live link 必须本轮明确授权。线上四套验收 19/34/32/52 全过（报告第 17 节）。**回退从未演练**；跨重新部署反馈持久性未验证（部署目录含 `server/data/feedback.sqlite3`，重发会随源码上传，有覆盖线上反馈的风险）。真人授权/四平台/识别准确率未达标；P3/P4、真实用户试用 0 人、讲述人实读、线上服务重启验证全部未完成，见 `docs/P2-P4-未完成清单与验收前置.md`。

### 0.7.0-web.9 P2 首版不变量（已发布到公网，仍有未验证项）
1. **持续字幕按秒计费**：300 秒音频预算 + 单片 ≤10s + `ASR_GATE` 并发 1 + 90 次/分；`_wav_seconds()` 读 RIFF 头，探测失败按上限扣（不能白嫖）；`segment=1` 走新预算，手动整段录音仍用旧次数配额。whisper 同步调用必须 `run_in_threadpool`。
2. **捕获不变量**：`getDisplayMedia({video,audio})` 后**必须**查 `getAudioTracks().length`；无音轨明确报错、**绝不退回麦克风**；video 轨只维持会话，不接元素/不取帧/不上传；worklet 输出接 `gain=0` 防朗读回环；停止 abort + 清队列 + stop 全部轨道 + close AudioContext。
3. **不造字**：静音片不上传、界面「等待声音 · 不会生成字幕」；去重/断句纯函数放 `src/shared/caption-pipeline.ts` 供 Node 单测；`p.m.` 规范化成两词，重叠裁剪要按规范化词数映射回原始词边界；句末 `900.` 必须能断句。片段只识别+翻译，**不调 `/api/reply`**。
4. **诚实边界**：本轮演示音频是 SAPI 合成语音经真实 MediaStream 注入的下游链路（非视频原声）；真人点选标签页、四平台、跨网页悬浮字幕**全未验证**；固定 3s 硬切片切在句中导致 `4:15→4.50 p.m.` 等真实识别误差，P2 只证明链路跑通，不证明翻译正确。
`git tag stable-web.9`（本轮）/ `stable-web.8` → `35c385a` / `stable-web.7` → `6b8a72e`；
8899 跑备份目录 web.8、8901 源码树 web.9、8902 部署副本预检、公网 web.9。
测试：单测 18 套 + 服务端 38 条 + `p2-verify.mjs` 52 项 + P0/P1 回归全过；
**线上** 19 项 + P0 34 步 + P1 32 步 + P2 52 项全过；报告第 16/17 节与
`docs/翻译其他网页视频-P2演示与兼容表.md`。
