# 保真硬化证据（2026-11-09）· general-purpose-2

> 记录本轮「网页端延迟授权竞态」与「关键事实 / 近音一致性」两部分的真实修复状态、
> 真实测试命令与真实数字。**不把「有测试」写成「模型准确率达标」。**

---

## 0. 范围与诚实边界（先读）

本轮只完成 **文本层 / 纯逻辑层**。

**文本测试 / 合成语音 / 真实语音三者不可互相替代：**

| 层次 | 能证明什么 | 不能证明什么 | 本轮 |
| --- | --- | --- | --- |
| 文本测试（给定文本 → 纯函数输出） | 规则对某段**文本**的处理是否正确、会不会倒退 | 不能证明 ASR 会把真人语音识别成这段文本；不能证明 TTS 发音正确；不能证明口音/噪声鲁棒性 | ✅ 本轮完成 |
| 合成语音（TTS 喂进链路） | 链路能收到音频、能切片、能出字幕 | 合成发音人/口音/噪声有限，不等于真人；不能外推到真实识别准确率 | ❌ 未做 |
| 真实语音（真人 + 真实环境） | 唯一能验证真实识别准确率、口音鲁棒性、真实噪声 | — | ❌ 未做 |

- 本轮**没有调用任何识别模型、没有生成或播放任何音频、没有伪造语音识别结果**。
- D 组「口音/拼写变体、噪声导致的重复片段、无声音、识别失败」全部是**构造的文本夹具**，
  用于验证纯函数对相应文本/数值输入的行为，不代表模型在任何一类音频上的准确率。
- 近音（汉字谐音）是**本地规则拼读的近似提示**，不是母语者核对过的发音，更不是发音准确率。

**验证方式说明：** 现有 `.dev/*unit.mjs` 都从 `dist/` 编译产物加载。本代理本地验证时用
`node_modules/.bin/esbuild` 把改动的 3 个 TS **单文件**转译到 `dist/shared/*.js`
（**不是 `npm run build`**），仅用于跑测试；主代理统一构建会重新生成 `dist` 并覆盖，
源码已改，构建后测试同样成立。`tabAudio.ts` 的测试用 esbuild 在内存里转译，不依赖 `dist`。

---

## 1. 改动文件（仅本代理）

| 文件 | 说明 |
| --- | --- |
| `webapp/web/src/tabAudio.ts` | `start()` 把授权等待纳入取消代次（generation + disposed） |
| `src/shared/numeric-check.ts` | 口语拼写时间 / 数字时间 + 时段词归一化到 24 小时制；裸 `4.20` 标 `ambiguous` 并给澄清措辞 |
| `src/shared/facts.ts` | `TIME_PATTERNS` 认拼写时间 + 时段词；`moneyLabels` 支持拼写数词；英文确认句不夹中文展示值 |
| `src/shared/reply-plan.ts` | `englishAmount` 支持拼写金额；`clarify-negation` 不夹中文；新增 `REPLY_VERSION` / `replyFingerprint` / 卡片 `sourceKey` |
| `.dev/tab-audio-race-unit.mjs` | 新建：任务 A 回归（纯逻辑 / 模拟 MediaStream） |
| `.dev/fidelity-hardening-unit.mjs` | 新建：任务 B 回归（文本层） |
| `docs/evidence-web/fidelity-hardening-20261109.md` | 本文件 |

未触碰：`src/renderer/`、`src/main/`、`webapp/server/`、`webapp/web/src/` 下除
`tabAudio.ts` 以外的文件、`docs/` 下其它文件、`git` 提交、发布副本、网站发布、`npm run build`。

---

## 2. 任务 A：网页端延迟授权竞态

**缺陷（已复现）：** `start()` 在 `await getDisplayMedia()` 期间没有纳入取消代次；弹窗未选完时
用户点停止或离开页面（卸载先 `dispose` 再 `stop`），授权返回后仍直接 `attach()`，
状态从 `requesting → stopping → stopped → capturing` 倒回去，新取得的 audio/video 轨仍 `live`。

**修复：** `start()` 请求之初 `const generation = ++this.generation`；授权返回后若
`generation !== this.generation || this.disposed`，**立即 `stream.getTracks()` 全部 `stop()`**
（audio 与 video 都停），不进入 `attach`、不把状态改成 `capturing`。授权失败（catch）同样先
检查，避免往已卸载组件报错。`pause()` / `resume()` 不改代次、也不是取消，授权返回仍正常启动。

**回归测试** `.dev/tab-audio-race-unit.mjs`：esbuild 内存转译 `tabAudio.ts`，注入
`@shared/caption-pipeline` / `./api` stub，mock `navigator` / `AudioContext` /
`AudioWorkletNode` / `MediaStream`；**不启动真实浏览器、不录音**。覆盖：
授权前停止、卸载顺序（dispose→stop）、只 dispose、授权后正常启动、重复点击、
暂停/继续期间授权返回、卸载后授权失败。
另含**自检段**：把修复块换回「授权返回直接 attach」的旧版代码重新加载，断言旧版确实会
错误地进入 `capturing` 且留下 `live` 轨道 —— 证明 A1/A2/A4 这组断言不是摆设。

---

## 3. 任务 B：关键事实与近音一致性

### 3.1 修复前的真实缺陷（`git show HEAD:src/shared/numeric-check.ts` 实跑对照）

```
旧版 scanTimes("four twenty in the afternoon"): []
旧版 scanNumbers("four twenty in the afternoon"): [4, 20]        ← 被当成两个金额数
旧版 consistency("four twenty in the afternoon", "下午4点20分"):
  关键信息对不上…原文的「four」（4）在译文里没出现；原文的「twenty」（20）没出现；
  译文时间「下午4点20分」≠ 原文（无时间）                        ← 时间等价被误报冲突
旧版 consistency("4.20", "下午4点20分"):
  …原文时间「4.20」（凌晨4点20分）在译文里没出现                  ← 被当成凌晨 4:20
```

事实层另两个真实缺陷（修复前实测）：
- `at 4.20 in the afternoon the deposit is 300` → money 里出现 `4.20`（时间被当金额）；
- 中文原话 `请确认定金是450欧元…` → 英文确认句 `Just to confirm, 450欧元, 周五.`（夹中文）；
  英文回复卡 `Sorry, so it's not 540欧元, right?`（夹中文）。

### 3.2 修复后的真实输出（同一批探针）

```
scanTimes("four twenty in the afternoon")            → 16:20
scanTimes("4.20 in the afternoon")                   → 16:20
scanTimes("4:20 p.m." / "16:20")                     → 16:20
scanNumbers("4.20", spans)                           → []           （不进金额/数值）
consistency("four twenty in the afternoon","下午4点20分") → ok
consistency("4:20 p.m.","16:20")                     → ok
consistency("4.20","下午4点20分")                    → warn + 澄清提示「没写明上午还是下午」，不含「凌晨」
facts("at 4.20 in the afternoon the deposit is 300")  → money 只有 300；time 为 "4.20 in the afternoon"
样例 B 回复首卡 → "Just to confirm, the deposit is three hundred euros and the remaining balance is nine hundred euros. Is that right?"
样例 C 确认句   → "Just to confirm, 450 euros, Friday. Is that right?"
样例 C 回复卡   → 三张 en 全部不含中文字符
```

### 3.3 关键规则改动

- `numeric-check.ts`：
  - 新增「英语口语数词 + 数词 + 时段词」识别（`four twenty in the afternoon`、`ten thirty a.m.`、
    `nine oh five at night`），归一化成 24 小时制（16:20），整段占用 `spans`，
    使 `scanNumbers` 不再把 `four`/`twenty` 拆成 4 和 20。
  - 新增「数字时间 + `in the morning/afternoon/evening/night`」（`4.20 in the afternoon` → 16:20）。
  - 裸点号 `4.20`（无 am/pm、无时段词、小时 ≤ 12）标 `TimeHit.ambiguous`，
    `checkNumericConsistency` 改给**澄清提示**，不硬写「凌晨4点20分」、不擅自 +12。
  - 时间等价表达 `4:20 p.m.` ↔ `four twenty in the afternoon` ↔ `16:20` ↔
    `4.20 in the afternoon` 全部归一到 16:20，不再误报冲突。
- `facts.ts`：`TIME_PATTERNS` 补两条（拼写时间 + 时段词、数字时间 + 时段词），
  使 `extractFactsWithRules` 产出 time 事实、并把 `4.20` 划进 `timeSpans` 从而不进裸金额；
  `moneyLabels` 认拼写数词（`three hundred euros` → 300 / `nine hundred euros` → 900），
  两笔钱各自带 `deposit` / `remaining balance` 标签；英文目标语言下中文展示值
  只做「数字 + 原话币种 / 星期」的封闭集合等价转写，推不出就 block，不硬造英文。
- `reply-plan.ts`：`englishAmount` 把「照抄纯英文原话」移到抽数字之前（拼写金额不再被
  `digits` 为空拒绝）；`clarify-negation` 不夹中文；新增 `REPLY_VERSION`(1)、
  `replyFingerprint(input)` 与每张卡的 `sourceKey`，作为「原文/事实一改旧回复即失效」的闸门。

**「不得擅自补币种或时间」：** 币种只从原话读（`currencyOf`），读不到只给数字并问币种；
没有时段词的时间（`four twenty`、裸 `4.20`）不猜上午下午，只给澄清提示。

### 3.4 三组样例与文本夹具

- 样例 A：450 欧元 / 周五有效；540 欧元 / 周四标 `negated` 且不进确认句。
- 样例 B：时间事实 `four twenty in the afternoon`（归一 16:20）、定金 300 欧元、
  余款 900 欧元分开说；`4.20` 不进金额；时间等价不误报；回复首卡不混入时间片段。
- 样例 C：中文原话 → 英文确认句保留 450 euros / Friday / 否定关系，英文句与回复卡均不夹中文。
- 文本夹具（**明确标注：不是真实音频测试**）：转写拼写变体、噪声重复片段去重、
  全零 PCM 判静音、空识别文本不产出字幕、拼写变体近音一致。
- 近音：`transliterate('450 euros')` 的数字读法与币种读法都在，
  `missingNumberHints` 为空；英文句不混入中文展示值。
- 版本闸门：近音现成 `HINT_VERSION=2` + 基于原文范围的片段 id（原文改后无错位片段）；
  回复本轮补 `REPLY_VERSION=1` + `replyFingerprint`（相同输入稳定、改原文/改事实都变化、
  每张卡 `sourceKey` 等于该指纹）。

---

## 4. 真实测试命令与数字（2026-11-09 本机实跑）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run test:unit` | `EXIT=0`，20 个现有用例脚本全部 0 失败（逐项数字见下） |
| 2 | `node .dev/tab-audio-race-unit.mjs` | `[tab-audio-race] 通过 28 条，失败 0 条`（EXIT=0，含旧版自检 2 条） |
| 3 | `node .dev/fidelity-hardening-unit.mjs` | `[fidelity-hardening] 通过 64 条，失败 0 条`（EXIT=0） |
| 4 | `node_modules/.bin/tsc -p tsconfig.main.json --noEmit` | `EXIT=0`（无类型错误） |

命令 1 的逐项输出（真实数字，均为 `失败 0`）：

```
RESULT PASS 192/192     RESULT PASS 183/183     ✓ 69/69 全部通过
通过 53 条，失败 0 条   PASS 80/80 全部通过    PASS 16/16 全部通过
RESULT: PASS (11/11)    RESULT PASS 126/126     RESULT PASS 45/45
通过 79 条，失败 0 条   通过 23 条，失败 0 条   通过 90 条，失败 0 条
RESULT PASS 86/86       通过 24 条，失败 0 条   一致性检查：通过 80 条，失败 0 条
通过 35 条，失败 0 条   通过 52 条，失败 0 条   p2-pipeline-unit: 32 passed, 0 failed
[P3 content/passage] 96 passed, 0 failed
EXIT_TEST_UNIT=0
```

**新测试挂进 `test:unit`：** 本代理授权范围不含 `package.json`，**未修改**它。
请主代理在 `npm run test:unit` 脚本末尾追加：

```
&& node .dev/tab-audio-race-unit.mjs && node .dev/fidelity-hardening-unit.mjs
```

单独运行（不依赖主代理构建，命令 2 完全不读 `dist`；命令 3 读 `dist`，
需主代理 `build:main` 或本地单文件 esbuild 转译后的 `dist/shared/*.js`）：

```
node .dev/tab-audio-race-unit.mjs
node .dev/fidelity-hardening-unit.mjs
```

---

## 5. 缺陷真实修复状态一览

| 缺陷 | 状态 | 说明 |
| --- | --- | --- |
| A：授权前 stop/dispose，授权返回仍 attach 到 capturing、轨道 live | **修好** | 授权代次 + 返回后停全部 audio/video 轨；28 条回归 + 旧版自检 |
| A：卸载后授权失败仍往组件报错 | **修好** | catch 先检查代次/disposed |
| B：`four twenty in the afternoon` 被当成数值 4/20、时间事实丢失 | **修好** | 归一 16:20 并占用 span；facts 产出 time 事实 |
| B：`4.20` 被当成凌晨 4:20（有 afternoon 语境时） | **修好** | `4.20 in the afternoon` → 16:20 |
| B：`4.20` 被当成金额（时间语境） | **修好** | facts `timeSpans` 排除；`scanNumbers` 不进数值 |
| B：时间等价表达 4:20 ↔ four twenty ↔ 16:20 误报冲突 | **修好** | 全部归一 16:20，一致性检查 ok |
| B：回复句把时间与 300/900 混在一起 | **部分修好** | `planReplies` 首卡把定金/余款分开且不含时间；`planConfirmSentence` 通用拼法仍把 time 事实与金额**逐条并列**（但时间已不再被当作金额数字）。见遗留问题 |
| B：两笔钱无标签混成「300 和 900」 | **修好** | `moneyLabels` 支持拼写数词，回复卡写明 `deposit` / `remaining balance` |
| C：英文确认句 / 回复卡混入中文展示值 | **修好** | 封闭集合等价转写 + `clarify-negation` 守卫；三张回复卡 en 全部无 CJK |
| 近音覆盖数字与币种、英文句不夹中文 | **已验证**（本轮补回归，未改 pronunciation.ts） | 现有实现已修复数字静默丢失；补 64 条回归钉住 |
| 原文/事实改后旧**近音**失效 | **现成闸门，已验证** | `HINT_VERSION=2` + 原文范围片段 id（hint-unit 已有，本轮再验） |
| 原文/事实改后旧**回复**失效 | **补了最小实现** | `REPLY_VERSION` + `replyFingerprint` + 卡片 `sourceKey`；未接入缓存/展示层（不在授权范围） |
| 无法确定时给澄清提示、不擅自补币种或时间 | **修好** | ambiguous 澄清措辞；币种只从原话读；无时段词不猜时刻 |
| 口音/拼写变体、噪声重复、无声音、识别失败 | **文本层回归已补**（明确是文本夹具） | 非真实音频/ASR 验证 |

---

## 6. 遗留问题（如实记录）

1. **裸 `4.20`（完全无时段词、无 am/pm）** 仍按字面 `4:20` 标 `ambiguous`，只给
   「没写明上午还是下午，请确认」的澄清提示，**不擅自补成 16:20、也不硬说成凌晨**。
   这是「无法确定时给澄清提示，不得擅自补时间」的设计结果，不是漏修。
2. **`four twenty`（没有任何时段词）** 不猜时刻，仍作为数值 4 / 20 处理。
3. `planConfirmSentence` 的通用拼法仍把当前事实逐条并列；样例 B 的日常回复卡
   （`planReplies` 的 `confirm-money`）已把两笔钱与时间分开，但通用确认句未拆成两句。
4. `replyFingerprint` 是**最小实现**（算法版本 + 输入内容指纹，附在回复卡 `sourceKey`），
   尚未接入 renderer / main 的缓存与展示层 —— 那些目录不在本代理授权范围。
5. 纯汉字数字金额（「一万五千」）仍是已知缺口，见 `.dev/asr-output-unit.mjs` E3 既有记录。
6. **未做** TTS 合成语音验证、真实真人语音验证、模型识别准确率验证；未播放/录制任何音频。
7. 两个新测试文件**未挂进** `package.json` 的 `test:unit`（不在授权范围），需主代理按第 4 节追加。
8. 未运行 `npm run build`（主代理统一构建）；本地仅用 esbuild 单文件转译到 `dist` 供验证。
