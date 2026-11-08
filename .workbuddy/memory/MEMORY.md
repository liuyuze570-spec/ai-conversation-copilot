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
