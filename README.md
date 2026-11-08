# AI Conversation Copilot（AI 英语 / 俄语 / 日语 / 韩语对话副驾驶）

一个运行在 Windows 桌面端的 **AI 实时多语言对话副驾驶**。

当你在 Zoom / Google Meet / Teams / 微信视频 / HelloTalk 网页版里和外国人一对一聊天时，它悬浮在屏幕角落：

```
系统播放的英文声音
  → WASAPI Loopback 采集
  → VAD 静音检测 / 分段
  → Whisper 语音识别（英文字幕）
  → LLM 口语化中文翻译
  → 你卡住时按 Alt+Space
  → AI 根据最近上下文生成 3 条"能说出口"的英文
  → 音节 / IPA / 中文近似音 / TTS
  → 你自己开口说
```

所有内容只显示在你自己的屏幕上。

---

## v0.6.0：听障使用者的跨语言沟通助手

这一版把定位收窄成一句话：**帮助听障使用者理解跨语言交流内容，并通过文字、可选的熟悉文字读音提示或软件朗读完成回应。**

四个变化：

1. **语言方向拆成四件事**（原来是写死的中文界面 + 中文译文 + 汉字近音）：
   界面语言 / 你理解的语言 / 我想说的语言 / 读音提示体系，各自独立。**不按国籍推断语言。**
   做透的三个方向：中文 → 英语（汉字近音）、日本語 → 英語（片假名）、English → 日本語（罗马字）。
2. **读音提示从「整句近似」改成「逐词片段 + 原文范围」**：
   点原文里任意一个词，提示行对应那段同时亮起；打不到的词标「未确定」画虚线，**不编读音**。
   日语读音引擎重写，修掉 `カメラ→kara`、`カタカナ→kaka`、`コーヒー→kohi`、`空港→空港` 四个实测错误。
3. **双面沟通卡**：自己那面看释义 + 读音提示，翻过去是给对方看的一句 30px 大字原文 + 手动朗读键。不自动朗读、不自动发送。
4. **历史记录保存当时的语言与提示体系**（SQLite schema v2，只加列不删数据），换过理解语言之后旧记录不会被当成新体系去理解。

配套文档：`docs/语言方向与读音辅助-v0.6.0.md`、`docs/测试记录表-v0.6.0.md`、`docs/打包核对-v0.6.0.md`、`docs/路演材料-5页-v0.6.0.md`、`docs/使用说明-v0.6.0.md`、`docs/数据存储与备份-v0.6.0.md`、`docs/成员贡献与工具使用-v0.6.0.md`、`docs/目标使用者体验记录表-v0.6.0.md`、`docs/视频脚本-2分钟-v0.6.0.md`（脚本已写、视频未录）、`docs/evidence-v0.6.0/`（自检截图与机器可读报告）。

---

## 当前完成状态

**Phase 1（全部完成，已实测通过）**

- Electron 33 + React 18 + TypeScript + Vite + Tailwind 工程，`npm run dev` 一键启动
- 透明、置顶、可拖动、可缩放、可调不透明度的 Desktop Overlay（紧凑 / 完整两种模式）
- Mock Conversation：无需 API Key 即可完整演示 字幕 → 翻译 → AI 回复 → 发音辅助 → TTS 全链路
- **Demo 语料库（`services/mock/corpus.ts`）**：日常寒暄 / 生活琐事 / 感情想念 / 朋友网络用语 / 工作会议 / 吐槽抱怨 / 低落安慰 / 旅行 / 学习 9 组真实场景轮换播放，每句带口语化中文翻译
- **多语言支持**：英语 / 俄语 / 日语 / 韩语；设置里切换后，Mock 语料、AI 回复、TTS、发音辅助都会跟随目标语言（日语/韩语/俄语额外显示罗马音）
- **语气 / 情绪选择**：自动 · 开心 · 期待 · 感谢 · 调侃 · 难过 · 失望 · 担心 · 生气 · 吐槽——选中后 AI 帮回复按该情绪生成（Mock 与真实 LLM 均支持；强烈情绪只针对事情，不含脏话与侮辱）
- **字幕历史可无限上下翻**：不再只显示最近几条，向上滚动即暂停自动跟随，一键「回到最新」；保留条数可在设置中调（默认 200 条）
- **「AI 帮回复」有关闭按钮**：面板右上角「× 关闭」，全局快捷键 `Alt+X` 一键收起
- **实测可用：监听任何软件的播放声音（WASAPI 回环）**——浏览器、哔哩哔哩电脑版、播放器、会议、网课都行，无需为每个软件配置。默认就开着真实采集（不再是演示模式）
- **实时音量条**：标题栏下方常显，一眼看出电脑的声音有没有真的进来（含设备来源、已采集秒数、当前 dB）
- **空态智能诊断**：字幕区空白时不再是干等，而是直接告诉你是哪种情况——演示模式 / 还没开始监听 / 采集不到声音（带 4 步排查清单）/ 声音进来了但缺 API Key
- **一键诊断（设置 → 音频）**：录 2.5 秒真实音频并报告设备名、采样率、声道与电平，直接区分「采不到音」和「识别不了」
- **音频组件开箱即用**：安装包自带一份便携 Python 运行时（numpy + soundcard，约 60MB）。朋友的电脑**不用装 Python、不用 pip install** 就能采集声音。解析顺序：设置里指定的路径 → 安装包自带 → 开发机 venv → PATH 中的 `python` / `py`；每个候选都会真跑一次 `import soundcard, numpy` 校验，不会静默失效
- **场景模式：实时对话 / 看视频 / 四六级听力**：
  - **看视频 / 影视**——顶部固定一条实时翻译浮层，对方说的每一句都边流边说边翻译（半句也会防抖翻译一次）；对方停下来（也就是你暂停视频）超过设定秒数，就自动生成可直接说出口的回应，卡片标签变为「简单反应 / 自然回应 / 追问一句」
  - **四六级听力**——同一套实时翻译，但暂停/停顿后给出的是「关键要点 / 参考答案 / 拓展表达」，用于听力理解和口语作答练习
  - 底部「场景」一行随时切换；`Alt+V` 一键进出看视频模式
- **停顿判定可调**：设置里可调「停顿几秒算暂停」与是否自动生成回复（默认 2.5s，仅视频 / 考试模式生效）
- **对话记录（本机持久保存，0.5.0 起）**：字幕区顶部「＋新记录 / 记录」可新建或切换会话；每条消息定稿即写入本机 SQLite（`%APPDATA%\ai-conversation-copilot\history.db`），关闭、重启、升级都不会丢；支持分页上翻、搜索（标题 / 原文 / 译文 / 谐音）、导出（文本 / JSON）、一致性备份与逐段删除。界面只有拿到写入回执才显示「已保存」
- **发音卡更醒目**：中文近似音 / 罗马音 / 音节收进高亮框（原来是三行灰字），中文近似音放大到 13px；每张卡片带 🔊 播放与 `0.7x` 慢速播放，方便跟着念
- Conversation Context Store（最近 60 秒 / 12 条上下文缓冲）
- Provider 抽象：`SpeechToTextProvider` / `TranslationProvider` / `LLMProvider` / `TTSProvider` / `AudioCaptureProvider`
- 首次启动隐私提示（写明哪些内容会存在本机、本地保存不等于加密）；API Key 用 Windows DPAPI（Electron safeStorage）加密保存
- 全局快捷键：`Alt+Space` 帮我回复 · `Alt+R` 我没听清 · `Alt+Q` 继续话题 · `Alt+P` 暂停/恢复 · `Alt+X` 关闭 AI 帮回复 · `Alt+V` 看视频模式（被占用时自动回退 Ctrl+Alt+?）

**Phase 2（已完成并实测）**

- Python sidecar（`soundcard`）通过 WASAPI Loopback 采集系统声音，PCM16/16kHz mono 经 stdout 传给主进程
- 能量自适应 VAD（噪声底自动跟踪 + 静音判定可调，默认 700ms）
- 说话期间每 2.5s 出一次 partial 字幕，静音后整句 final 识别
- 支持系统声音（对方）+ 麦克风（自己）双声道，speaker 标记 `foreign / user`
- 设备枚举：设置页里可选系统声音设备 / 麦克风设备
- 实测：TTS 播放英文时 VAD 命中率 51/82 帧，静音帧 RMS=0

**Phase 3（已完成并实测）**

- **设置页拆成两个标签**：`常用功能`（语言 · 场景 · 发音 · 字幕 · 窗口 · 音频 · 资料）与 `API 功能`（连模型）。原来所有选项堆在一条长滚动条里，想改音量得先滑过一堆 Base URL；现在各归各位，API 标签上还有一个琥珀色小圆点提示「模型还没配好」。
- **只连国内模型（硬规则）**：内置 9 家国内服务商预设（硅基流动 / 魔搭 / 智谱 / 月之暗面 / DeepSeek / 阿里云百炼 / 腾讯混元 / 火山方舟 / 阶跃星辰）+ 自定义。**渲染层即时校验 + 主进程二次把关**，填境外地址（OpenAI / Claude / Groq / Gemini…）会被直接拒绝并说明原因；本机地址（localhost / 内网 IP）放行。
- **老配置自动迁移**：升级后如果发现存的是境外或空地址，启动时自动切换到「硅基流动」（推荐），用户不需要手动改任何东西。
- **连接稳定性加固**：所有网络请求统一走 `fetchWithRetry`——单次超时（LLM 45s / STT 60s）+ 指数退避重试（网络错误 / 408 / 429 / 5xx，最多 2 次，带随机抖动），并被 `AbortController` 兜底，不会永远卡在「思考中」。
- **「测试连接」真的发一次请求**：明确告诉你卡在「地址 / Key / 模型」哪一步，并顺手拉取服务商模型列表填进下拉框。错误统一中文化（401 说「Key 与地址不是同一家」、404 说「地址或模型名不对」、429 说「额度用完，换一家免费模型」…）。
- **一个 Key 管两件事**：文字模型与语音识别若是同一家（如硅基流动），自动共用一把 Key，不用填两次；不是同一家时可以分别配。
- **新手图文教程**：`docs/新手连接免费模型教程.html`（随安装包一起分发，设置 → API 功能 → 「图文教程（新手必看）」一键打开；点某家服务商旁的「怎么申请 Key？」会**直接跳到那一家**的领取步骤）。结构：一句话题解 → 三条免费路线 → 软件里点 4 下（带界面示意图）→ **九家国内服务商各自的分步领取教程**（真实网址、按钮名、容易卡住的地方）→ 免费/收费红黑榜 → 测试开听 → 什么时候才需要花钱 → 报错对照表（含 402 余额不足）→ 检查清单 → 常见疑问。全部措辞按「小学生也能照着点」写。
- **下拉选择器全部改为自绘**：设置页里所有下拉（母语 / 对话语言 / 语言水平 / 回复长度 / 回复风格 / 语气 / 场景 / 界面模式 / 服务商 / 模型 / 音频设备）不再用原生 `<select>`，改成 DOM 自绘弹出层（portal 到 `body` + `position: fixed` + 打开时按触发器位置现算、下面放不下就朝上弹）。悬浮窗是「无边框 + 置顶 screen-saver + 面板带 `backdrop-filter` + 内部可滚动」，原生下拉的系统弹层在这种环境里会被裁切或点不动——这正是用户反馈的「回复风格怎么点都只能停在 natural」。
- **母语改成下拉**：以前是个自由文本框、默认值写死英文单词 `Chinese`，新手既不知道填什么也不知道填错会怎样；现在是下拉，默认「中文（简体）」，可选英语 / 俄语 / 日语 / 韩语，并加了一句说明区分「母语（翻译给你看）」和「对话语言（你要说的）」。默认组合即「母语=中文 + 对话语言=英语」。
- **回复风格 / 回复长度中文化**：原来下拉里只有 `simple / natural / friendly / funny / formal` 这种英文单词，根本分不清；现在每项都有中文名 + 一句说明（自然 / 简单 / 热情 / 幽默 / 正式），改完下一句回复立刻生效。

**Phase 4（已完成并实测）**

- **「语言水平」换成国内英语等级**：原来是 CEFR 的 `A1 / A2 / B1 / B2 / C1` —— 中国用户基本只在驾照上见过这种写法（反馈原话就是「这跟驾驶证一样吗」）。现在改成 **英语 B 级 / 英语 A 级 / 大学英语四级 / 大学英语六级 / 英语专业四级 / 英语专业八级**，每项带一句「这个水平能听懂什么」的说明，默认「大学英语四级」。模型提示词按这六档分别写，比原来的五档更细（六级和专四在国内是两个不同人群，句子长度和用词难度应该真的不一样）。
- **老设置自动迁移**：`A1/A2 → 英语B级`、`B1 → 四级`、`B2 → 六级`、`C1 → 专八`，启动时静默完成并写日志；无法识别的值回到默认四级。实测 `B2 → cet6` 落盘成功。
- **内置便携 Python 运行时**：`scripts/prepare-python-runtime.js` 下载官方 embeddable Python、从本机 site-packages 搬来 numpy / soundcard / cffi / pycparser、补齐 VC++ 运行库、裁掉 tests、写好 `pythonXX._pth`，产出 `vendor/python-runtime/`（约 60MB）随安装包分发。实测这份运行时能枚举设备并跑通 `probe`（列出「扬声器 (2- Realtek(R) Audio)」，16kHz/2ch）。脚本只用 Node 内置能力（`fetch` + 自解 zip），不依赖任何外部进程。
- **「能不能发给朋友用」**：这轮的真正问题是"发过去能不能用"——缺的正是上面那份运行时。现在把安装包发给朋友，双击装上就能采集声音（不用装 Python），只需要自己领一把免费的 Key。教程新增第 8 章《想把软件发给朋友用？》，含分发方式对照表、安装时的「仍要运行」提示、以及**为什么每人必须各自领一把 Key**（Key 加密绑在本机 + 多人共用会被限流）。

**待用户填入国内服务的 Key 后即可出字幕**：设置 → API 功能 → 选服务商 → 粘贴 Key → 测试连接（看到绿色）→ 开始监听。

---

## 技术架构

```
src/
  main/                 Electron 主进程
    index.ts            入口：协议、IPC、快捷键、生命周期、设置写入校验（只允许国内）
    overlay-window.ts   透明置顶悬浮窗（copilot:// 协议加载，绕开 file:// CORS）
    settings-store.ts   设置持久化 + safeStorage 加密 API Key（LLM/STT 各一把）+ 境外地址自动迁移
    logger.ts           分级日志（INFO/WARN/ERROR），自动脱敏 API Key
    ai-service.ts       Provider 工厂（真实 / Mock）+ 连接测试 + 模型列表 + 错误中文化
    audio/
      audio-controller.ts  IPC：start/stop/devices/probe（一键诊断）
      python-engine.ts     Python 自动发现（优先用安装包自带的 vendor/python-runtime）+ WASAPI sidecar 进程管理 + stderr 事件解析（电平/静音/错误）+ VAD + 分段 STT
      mock-engine.ts       演示对话引擎（不采集真实声音，UI 会明确提示）
  preload.ts            contextBridge 暴露 copilot API（contextIsolation 开启）
  renderer/             React UI
    App.tsx             布局：标题栏 / 音量条 / 实时翻译浮层 / 字幕区 / 回复区 / 快捷操作
    components/         TitleBar · AudioMeter · AudioDiagnostics · LiveTranslateBar · SubtitleList · ReplyCard · ReplyPanel · QuickActions · SettingsPanel · RecordsPanel · PrivacyNotice
    components/settings/  SettingsPanel 拆分：controls.tsx（通用控件，含自绘下拉 Select）· GeneralSettings.tsx（常用功能）· ApiSettings.tsx（API 功能）
    stores/             zustand：conversation（缓冲）/ settings / ui（含 playback 播放状态 + 实时音频电平）/ ai-status（连接状态与测试结果）
    hooks/useCopilot.ts 转录→翻译→上下文→回复→TTS 的编排层（含实时翻译防抖 + 停顿检测自动回复）/ useSessions.ts
  services/             与 UI 无关的 Provider 实现
    llm/http.ts         统一 fetch 封装：超时 + 指数退避重试 + 可取消 + 错误详情提取
    llm/prompts.ts      「能说出口」回复 Prompt（英语等级分级 + 反幻觉 + 语气/表达库 + 场景规则）
    tone.ts             语气/情绪层：9 种情绪的 Prompt 规则 + Mock 回复模板 + 表达方式库
    llm/openai-compatible.ts / stt/openai-stt.ts / tts/{web-speech,openai-tts}.ts
    translation/llm-translator.ts
    mock/               Mock LLM / 翻译 / STT / corpus.ts 多场景语料库
    pronunciation.ts    离线音节切分 + 中文近似音 + 俄/日/韩罗马音
  python/audio_capture/loopback.py   WASAPI 回环 / 麦克风采集 sidecar
                                     （自适应采样率与声道、JSON 电平事件、devices / probe 子命令）
  shared/               主进程与渲染进程共享
    types.ts            设置与领域类型（含 DEFAULT_SETTINGS）
    ipc.ts              IPC 通道常量与 payload 类型
    providers.ts        国内服务商预设目录 + 域名白名单/黑名单校验 + Base URL 归一化
    ai-errors.ts        把网络/接口错误翻译成新手看得懂的中文
docs/                   随安装包分发的图文教程（新手连接免费模型教程.html）
vendor/python-runtime/  随包分发的便携 Python（numpy + soundcard），由 scripts/prepare-python-runtime.js 组装
scripts/                开发脚本：start-electron（清 ELECTRON_RUN_AS_NODE）· dist-win（ASCII 暂存打包）· open · prepare-python-runtime
```

---

## 开发环境

- Node.js ≥ 20（开发时用 22 实测）
- Python ≥ 3.10（仅真实音频捕获需要），依赖 `soundcard`、`numpy`
- Windows 10/11

## 安装依赖

```bash
npm install
```

国内网络已配置 npmmirror（见 `.npmrc`）。

## 配置 Python（真实音频捕获）

```bash
# 用任意 Python 3.10+ 创建环境并安装依赖
python -m pip install soundcard numpy -i https://mirrors.aliyun.com/pypi/simple/
```

应用默认自动探测 `C:/Users/25344/.workbuddy/binaries/python/envs/default/Scripts/python.exe`；
其他环境可在设置 → 音频里没有该选项时，修改设置文件中的 `audio.pythonPath`。

## 启动

```bash
# 开发（主进程 watch + Vite dev server + Electron）
npm run dev

# 生产构建 + 运行
npm run build
npm start
```

首次启动会显示隐私提示；默认就是**真实监听**——启动后立即采集系统声音。
此时即使还没填 API Key，也能看到标题栏下的音量条在跳（证明"听得到"），
只是还没法把语音转成文字。填上 Key 即可开始出字幕；只想预览界面时再打开「演示模式」。

## API 配置（只用国内模型）

**只差这一步就能出字幕。** 没填 Key 时，界面会明确提示「已经听到声音了，但还没有配置 API Key」。

**新手照做就行**：打开软件右上角 ⚙ → 切到「**API 功能**」标签 → ①下拉框选一家服务商 → ②粘贴 Key → ③选带「免费」字样的模型 → ④点「测试连接」看到绿色 → 关掉设置开始监听。

完整图文版见 **`docs/新手连接免费模型教程.html`**（设置 → API 功能 → 「图文教程（新手必看）」）。
教程按「先免费、后付费」组织：三条 0 元路线 → 软件操作 → 九家服务商各自的分步领取教程 → 免费模型红黑榜 → 测试开听 → 最后才是「什么时候才需要花钱」。

内置的国内服务商预设（点一下自动填好地址和模型，不用手打）：

| 服务商 | 文字模型 | 语音识别（字幕） | 免费情况 |
| --- | --- | --- | --- |
| **硅基流动 SiliconFlow（推荐）** | Qwen2.5-7B / GLM-4-9B / Qwen3-8B | ✅ SenseVoiceSmall | 小模型长期免费，一个 Key 全搞定 |
| 魔搭 ModelScope（阿里） | Qwen2.5-7B / Qwen3-8B | ✅ SenseVoiceSmall | 每天刷新免费额度 |
| 智谱 AI GLM | glm-4-flash | ❌ 需另配 | glm-4-flash 免费 |
| 阿里云百炼（通义千问） | qwen-turbo / qwen-flash | ✅ qwen3-asr-flash | 每个模型有免费额度 |
| 月之暗面 Kimi | moonshot-v1-8k / kimi-latest | ❌ 需另配 | 新号赠送额度 |
| 深度求索 DeepSeek | deepseek-chat / deepseek-reasoner | ❌ 需另配 | 按量付费，便宜 |
| 腾讯混元 | hunyuan-lite / hunyuan-turbos | ❌ 需另配 | hunyuan-lite 免费 |
| 火山方舟（豆包） | doubao-seed / doubao-pro | ❌ 需另配 | 新用户免费额度（需填 ep- 接入点 ID） |
| 阶跃星辰 StepFun | step-1-flash / step-2-mini | ❌ 需另配 | 注册赠送额度 |

> 只做文字的服务商被选中时，界面会提示并给出「用 硅基流动 做语音识别（免费）」一键按钮。

### 硬规则：只允许国内接口

渲染层边填边校验，主进程写入前再校验一次，两道闸门：

- **拒绝**：OpenAI / Azure / Anthropic / Claude / Groq / Gemini / Mistral / OpenRouter / HuggingFace 等境外域名；
- **放行**：上表所有服务商域名，以及任何 `.cn` / `.com.cn` 结尾的域名；
- **放行**：本机与内网地址（`localhost` / `127.0.0.1` / `10.x` / `192.168.x` / `172.16-31.x`）——方便自建网关。

拦截时会说明原因，并且**不是故障提示**。三个理由：① 国内直连不需要代理，更稳更快；② 电影 / 对话内容不出境；③ 国内免费额度更多。

### 连接稳定性

- 统一超时：LLM 45s、STT 60s、测试连接 20s、模型列表 15s；
- 自动重试：网络错误 / 408 / 429 / 5xx 最多重试 2 次，指数退避 400ms→800ms（+随机抖动，上限 4s）；
- 可取消：用户在重试中停止监听会立刻 `AbortController` 掉，不再有僵尸请求；
- 错误中文化：401/403「Key 不对或 Key 与地址不是同一家」、402「余额不足」、404「地址或模型名不对」、429「限流或额度用完」、5xx「服务商暂时不稳定」。

### 安全

Key 用 Windows DPAPI（Electron safeStorage）加密后存在 `settings.json`，日志自动脱敏；换电脑或重装系统需重填。


## Windows 音频设置

**监听什么？** 采集的是「系统当前播放的声音」（WASAPI Loopback 回环）。
这意味着它**天然支持所有软件**——浏览器、哔哩哔哩电脑版、PotPlayer / VLC、腾讯会议、
网易云音乐、网课客户端、游戏……只要声音是从**同一块默认输出设备**出来的，就能被听到，
不需要为每个软件单独配置。

- 采集的是「系统当前播放的声音」，不加入会议、不进房间（本机内部回环）。
- 请确保对方声音从本机扬声器/耳机输出（蓝牙耳机请在系统里选"立体声输出"而非"免提"）。
- **播放软件的输出设备必须和系统默认扬声器一致**。换过耳机后，有些软件仍指向旧设备，
  这是「电影在放但字幕不动」最常见的原因。
- 想识别自己说的话：设置 → 音频 → 打开「捕获麦克风」。
- 静音判定默认 900ms，识别偏碎可调大，字幕偏慢可调小。
- **灵敏度**（默认 1.4x）：电影对白偏轻、笔记本扬声器音量小时调高到 2–3x 明显改善。

### 看不到字幕时怎么查（三步）

1. 看标题栏下方的**实时音量条**——说话时它必须跳动。
   - 不跳 → 采集没拿到声音，看第 2 步；
   - 跳了 → 声音进来了，问题在识别（多为没填 API Key）。
2. 点设置 → 音频 →「**一键诊断**」。它会录 2.5 秒并报告设备名、采样率与电平：
   - `检测到声音 ✓` 但已经没字幕 → 缺 API Key 或网络问题；
   - `没有声音 ✗` → 设备被独占 / 播放软件输出到了别的设备 / 系统静音。
3. 确认**不是演示模式**。演示模式只播内置示例，永远听不到电脑的声音；
   快捷区出现橙色「演示模式」横幅时，点「监听系统声音」即可切换。

## 常见错误

| 现象 | 处理 |
| --- | --- |
| 窗口不见了 | 点系统托盘蓝色图标 →「显示 / 置前」，或设置 → 窗口 →「重置窗口位置」，或重新运行 `npm run open`（会打印窗口落点） |
| 窗口位置总是很偏 | 窗口默认出现在鼠标所在显示器的右上角；拖动后的位置会被记忆，越界会自动回正 |
| **放电影时字幕一直空白** | ① 标题栏下的音量条是否跳动；② 设置 → 音频 →「一键诊断」；③ 确认没开演示模式；④ 确认播放软件输出到系统默认扬声器。依次排查即可定位 |
| 音量条不跳，显示「没有听到任何声音」 | 系统静音 / 音量为 0 / 播放软件输出到了别的设备 / 该软件用了独占模式 |
| 音量条在跳但没字幕 | 没配 API Key（诊断卡片会直接提示）。填上 Key 后无需重启即会开始识别 |
| 「这个接口不是国内的」 | 硬规则，不是故障。请在设置 → API 功能 → 第 1 步从国内服务商里选一家（推荐硅基流动） |
| 测试连接报 401 / 403 | Key 复制不全，或 Key 和「接口地址」不是同一家（例如拿智谱的 Key 去连硅基流动）。重新复制一次 |
| 测试连接报 404 | 接口地址或模型名不对。地址用服务商给的（如 `https://api.siliconflow.cn/v1`），模型从下拉框选 |
| 测试连接报 429 | 请求太快或免费额度用完。等一分钟；一直如此就换一家（硅基流动 / 魔搭 / 智谱 glm-4-flash） |
| 测试连接报 5xx | 服务商临时抖动，已自动重试过。等几分钟或换一家 |
| 选了只有文字模型的服务商，字幕不出 | 该家不做语音识别。点「用 硅基流动 做语音识别（免费）」一键切换 |
| 找不到新手教程 | 设置 → API 功能 → 「图文教程（新手必看）」；或直接打开 `docs/新手连接免费模型教程.html` |
| `无法启动 Python 音频进程` | 没找到可用的 Python。程序会自动依次尝试：设置里的 `pythonPath` → 内置 venv → PATH 里的 `python`/`py`；都不行就在设置里填完整路径，并确保装了 `soundcard`、`numpy` |
| `no capture device` | 设备被独占（如某些会议软件），关掉占用方或换个输出设备 |
| `Speech recognition unavailable` | Key 无效 / 网络不通 / 触发限流，查看日志：`%APPDATA%/ai-conversation-copilot/logs/app.log` |
| 快捷键无效 | 可能被其他软件占用，日志中会提示已回退为 `Ctrl+Alt+?` |
| 字幕偏碎、一句话被拆成几段 | 调大设置 → 音频 →「静音判定」（900 → 1200ms） |
| 示例对话不自动播放 | 默认关闭；演示模式下打开「自动播放示例对话」，或点「说一句示例」手动来一句 |
| 看视频模式不自动生成回复 | 只有「看视频 / 四六级听力」场景才会停顿触发；检查设置 → 场景 → 「停顿自动生成回复」是否打开，以及「停顿判定」秒数（对方一直说话就不会触发） |
| 切换语言后 TTS 没变化 | Web Speech 按目标语言选嗓音；如系统无对应语音，会 fallback 到默认嗓音 |

> 已知坑：窗口若使用 `transparent: true`，在没有 GPU 合成的环境（部分沙箱 / 远程桌面）
> 会整窗不可见——进程活着、Win32 窗口也在，但屏幕上什么都没有。本项目已改用
> 不透明深色窗口规避；如需恢复玻璃拟态，请先确认目标机器 GPU 合成正常。

## 打包 Windows 安装程序

```bash
npm run dist:win
```

产物在 `release/AI-Conversation-Copilot-Setup-<version>.exe`（NSIS 安装器，可自选安装目录）；
`release/win-unpacked/` 为免安装便携版。Python 采集脚本通过 `extraResources` 打进安装包。
以上流程已在项目内实际跑通并冒烟验证（打包版可正常启动、渲染、Mock 演示）。

> 说明：项目路径包含中文时 `app-builder.exe` 会因编码问题崩溃，`npm run dist:win`
> 已内置处理——自动把项目复制到 `%LOCALAPPDATA%\ai-copilot-build` 打包再把产物拷回。
> 未签名构建跳过了 `signAndEditExecutable`（无管理员权限时 winCodeSign 无法解压），
> 因此 exe 使用 Electron 默认图标；如需自定义图标与签名，配置证书后删除
> `package.json` 中 `build.win.signAndEditExecutable: false` 即可。

## 隐私与安全

- 不录像、不保存视频、不永久保存原始音频
- 识别出来的文字（原文 / 译文 / 谐音）保存在本机数据库，关掉 / 重启 / 升级都不删；可逐段删除、可导出；**本地保存不等于加密**
- 临时音频只存在于内存 Buffer，不写入磁盘；日志只记状态、错误码、字数与耗时
- API Key 通过 Electron safeStorage（Windows DPAPI）加密存储，日志自动脱敏
- 所有识别、翻译、回复仅显示在本机屏幕
