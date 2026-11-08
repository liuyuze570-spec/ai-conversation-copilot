/**
 * 0.4.0「比赛改进」这一批改动的回归单测。
 *
 * 全部 import 自 `dist/` —— 跑的就是打包进安装包的同一份代码。
 *
 * 覆盖：
 *   A. 启动闸门：同配置不重复起引擎、引擎死了必须能重起、启动回执的四种结果
 *   B. 音频状态机：连接中 / 采集中 / 暂未收到声音 / 失败 四种说法不串味
 *   C. 信号窗口：最近 8 秒内有没有声音（不能用「全程最大值」）
 *   D. 音源与说话角色：线上 = 系统声音是对方；现场 = 麦克风是对方且要翻译
 *   E. 阅读排版：字号钳制、旧设置迁移、大字模式阈值、对比度实测值
 *   F. 译文四态：有译文就算 ok；停止监听把 pending 转 cancelled
 *   G. 沟通卡：三张卡、不联网、复制文本中英都有
 *   H. 三组样例：规则能抓住时间 / 否定改期 / 金额纠正
 *   I. 错误结构化：给用户看的错误里不带服务商原文
 *
 * 不联网、不碰真实 Key、不录音。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);

const gate = require('../dist/shared/pipeline-gate.js');
const audioState = require('../dist/shared/audio-state.js');
const sources = require('../dist/shared/sources.js');
const reading = require('../dist/shared/reading.js');
const subtitleState = require('../dist/shared/subtitle-state.js');
const commCards = require('../dist/shared/comm-cards.js');
const samples = require('../dist/shared/samples.js');
const facts = require('../dist/shared/facts.js');
const aiErrors = require('../dist/shared/ai-errors.js');
const history = require('../dist/shared/history.js');

let total = 0;
let failed = 0;

function eq(actual, expected, msg) {
  total += 1;
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    failed += 1;
    console.log(
      `  FAIL ${msg}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`,
    );
  }
}

function ok(cond, msg, extra) {
  total += 1;
  if (!cond) {
    failed += 1;
    console.log(`  FAIL ${msg}${extra === undefined ? '' : ' -> ' + extra}`);
  }
}

// ---------------------------------------------------------------------------
// A. 启动闸门
// ---------------------------------------------------------------------------
console.log('A. 启动闸门（不重复起引擎 / 死了能重起）');
{
  const config = {
    mockMode: false,
    captureSystemAudio: true,
    captureMicrophone: false,
    systemDeviceId: 'default',
    micDeviceId: 'default',
    pythonPath: 'py',
    demoAutoPlay: false,
    targetLanguage: 'English',
  };
  const signature = gate.pipelineSignature(config);

  ok(gate.shouldRestartPipeline('', config) === true, 'A1 没在跑 → 要启动');
  ok(
    gate.shouldRestartPipeline(signature, config) === false,
    'A2 配置相同且引擎活着 → 不许 stop→start（否则每次开机白起一个采集进程）',
  );
  ok(
    gate.shouldRestartPipeline(signature, config, false) === true,
    'A3 指纹相同但引擎已死 → 必须重起（旧 bug：这里返回 false，点开始永远没反应）',
  );
  ok(
    gate.shouldRestartPipeline(signature, { ...config, captureSystemAudio: false }, true) === true,
    'A4 配置变了 → 要重起',
  );

  // 启动回执：只有 running / skipped 才算成功，pending 不许当失败、更不许当成功。
  ok(gate.startSucceeded({ kind: 'running', message: '' }) === true, 'A5 设备确认启动 → 成功');
  ok(gate.startSucceeded({ kind: 'skipped', message: '' }) === true, 'A6 已在跑被跳过 → 成功');
  ok(
    gate.startSucceeded({ kind: 'pending', message: '' }) === false,
    'A7 超时未确认 → 不算成功（保留进程，界面写「正在连接」）',
  );
  ok(gate.startSucceeded({ kind: 'failed', message: '' }) === false, 'A8 明确失败 → 不算成功');
}

// ---------------------------------------------------------------------------
// B. 音频状态机
// ---------------------------------------------------------------------------
console.log('B. 音频状态机');
{
  const base = { hasSignal: false, engineAlive: true };
  eq(audioState.audioUiState('starting', base).phase, 'starting', 'B1 starting → 连接中');
  eq(audioState.audioUiState('listening', { ...base, hasSignal: true }).phase, 'live', 'B2 有信号 → 正在采集');
  eq(audioState.audioUiState('listening', base).phase, 'silent', 'B3 没信号 → 采集中但暂未收到声音');
  eq(audioState.audioUiState('listening', base).tone, 'warn', 'B4 「暂未收到声音」必须是提醒色，不能是绿色');
  ok(
    audioState.audioUiState('listening', base).label.includes('暂未收到'),
    'B5 文案要说明「还在采集」，否则用户以为停了',
  );
  eq(audioState.audioUiState('error', base).phase, 'failed', 'B6 error → 失败');
  eq(
    audioState.audioUiState('error', base).showReconnect,
    true,
    'B7 失败时必须给「重新连接」入口',
  );
  eq(audioState.audioUiState('paused', base).phase, 'paused', 'B8 paused → 已暂停');
  eq(audioState.audioUiState('idle', base).phase, 'starting', 'B9 idle 但引擎在 → 仍在连接（别报「未开始」）');
  eq(
    audioState.audioUiState('idle', { ...base, engineAlive: false }).phase,
    'stopped',
    'B10 idle 且没引擎 → 未开始',
  );
  ok(
    audioState.audioUiState('error', base).announcement.length > 4,
    'B11 每个状态都要有一句能读出来的话（不能只有颜色）',
  );
}

// ---------------------------------------------------------------------------
// C. 信号窗口
// ---------------------------------------------------------------------------
console.log('C. 信号窗口（最近 8 秒，不是全程最大值）');
{
  const t0 = 1_000_000;
  let win = [];
  win = audioState.pushSignal(win, { at: t0, db: -20 });
  ok(audioState.hasRecentSignal(win, t0 + 1000), 'C1 刚响过 → 有信号');
  ok(audioState.hasRecentSignal(win, t0 + 7000), 'C2 7 秒前响过 → 还算有信号');
  ok(!audioState.hasRecentSignal(win, t0 + 9000), 'C3 9 秒前响过 → 不算（这正是旧实现漏掉的情况）');
  win = audioState.pushSignal(win, { at: t0 + 9000, db: -20 });
  ok(win.length === 1, 'C4 推新样本时丢掉窗口外的旧样本（窗口不会无限长）');
  ok(!audioState.hasRecentSignal([{ at: t0, db: -80 }], t0 + 100), 'C5 底噪以下不算有声音');
  ok(!audioState.hasRecentSignal([], t0), 'C6 空窗口算没有信号');
  ok(
    audioState.hasRecentSignal([{ at: t0, db: -54 }], t0 + 100),
    'C7 -54dBFS 略高于底噪 → 算有声音（别把小声说话漏掉）',
  );
  ok(audioState.SIGNAL_WINDOW_MS === 8000, 'C8 窗口长度是 8 秒');
}

// ---------------------------------------------------------------------------
// D. 音源与说话角色
// ---------------------------------------------------------------------------
console.log('D. 音源与说话角色');
{
  eq(sources.speakerOf('loopback', 'online'), 'foreign', 'D1 线上：系统声音是对方');
  eq(sources.speakerOf('mic', 'online'), 'user', 'D2 线上：麦克风是自己');
  eq(sources.speakerOf('mic', 'onsite'), 'foreign', 'D3 现场：麦克风是对方（旧代码在这里写死 user）');
  eq(sources.speakerOf('loopback', 'onsite'), 'foreign', 'D4 回环永远是对方');

  const online = sources.resolveSources({
    sourceMode: 'online',
    captureSystemAudio: true,
    captureMicrophone: true,
  });
  eq(online.items.length, 2, 'D5 线上双音源 → 两条');
  eq(online.primary, 'loopback', 'D6 线上以系统声音为主通道');
  eq(online.items[0].translate, true, 'D7 系统声音要翻译');
  eq(online.items[1].translate, false, 'D8 线上麦克风（自己）不翻译');

  const onsite = sources.resolveSources({
    sourceMode: 'onsite',
    captureSystemAudio: false,
    captureMicrophone: true,
  });
  eq(onsite.items.length, 1, 'D9 现场只采麦克风');
  eq(onsite.items[0].speaker, 'foreign', 'D10 现场的麦克风里是对方');
  eq(onsite.items[0].translate, true, 'D11 现场模式麦克风必须进翻译链路，否则等于没做');
  eq(onsite.primary, 'mic', 'D12 现场主通道是麦克风');

  const conflict = sources.resolveSources({
    sourceMode: 'onsite',
    captureSystemAudio: true,
    captureMicrophone: true,
  });
  eq(conflict.items.length, 1, 'D13 现场 + 系统声音 → 只留麦克风，避免同一句话两遍字幕');
  ok(Boolean(conflict.warning), 'D14 让位必须有说明，不能悄悄少一路');

  const empty = sources.resolveSources({
    sourceMode: 'onsite',
    captureSystemAudio: false,
    captureMicrophone: false,
  });
  eq(empty.items.length, 0, 'D15 现场没开麦克风 → 没有音源');
  eq(empty.primary, 'none', 'D16 没有音源时 primary 是 none');
  ok(/麦克风/.test(empty.warning || ''), 'D17 提示要说清「现场要用麦克风」');
}

// ---------------------------------------------------------------------------
// E. 阅读排版
// ---------------------------------------------------------------------------
console.log('E. 阅读排版与对比度');
{
  // 0.5.0：三类文字统一 12–64px。旧版是三套范围（译文 18–40、原文 12–32），
  // 「谐音 = 原文 − 3px」这种绑定必须彻底没了。
  eq(reading.clampFont(1), 12, 'E1 下限 12px');
  eq(reading.clampFont(99), 64, 'E2 上限 64px（460px 宽窗口里仍读得到）');
  eq(reading.clampFont(30.6), 31, 'E3 取整到像素');
  eq(reading.clampFont(Number.NaN), 12, 'E4 NaN 兜底到下限，不能变成 0px 隐形字');

  /*
   * 0.6.0 起，`readingPrefs()` **只钳范围，不做版本迁移**。
   *
   * 0.5.0 把「15→18 / 23→24」写在这里，于是每次渲染都在迁移：用户主动把原文
   * 调成 15px，下次打开又被改回 18，而界面没有任何说明。
   * 迁移已经挪到 `main/settings-store.ts`，由 `settings.readingVersion` 控制只跑
   * 一次（见 `.dev/reading-unit.mjs` 的 C/D 两组）。这里只断言「读什么给什么」。
   */
  const legacy = reading.readingPrefs({ fontSize: 15 });
  eq(legacy.originalFontSize, 15, 'E5 老字段 fontSize 只决定原文，且不再被改成 18');
  eq(legacy.translationFontSize, 24, 'E6 没给译文时用默认 24（不再等于原文减 2）');
  eq(legacy.romanizationFontSize, 18, 'E7 谐音没有历史值，从 18 起步');
  eq(legacy.readingMode, 'both', 'E8 默认阅读方式');
  eq(reading.readingPrefs({ originalFontSize: 23 }).originalFontSize, 23, 'E8b 用户选的 23 原样保留');
  eq(
    reading.readingPrefs({ translationFontSize: 23 }).translationFontSize,
    23,
    'E8c 用户选的译文 23 原样保留',
  );

  const kept = reading.readingPrefs({ fontSize: 20, translationFontSize: 30 });
  eq(kept.originalFontSize, 20, 'E9 用户自己调的原文 20 不许被改');
  eq(kept.translationFontSize, 30, 'E10 用户自己调的译文 30 不许被改');

  const tiny = reading.readingPrefs({ originalFontSize: 8, translationFontSize: 200 });
  eq(tiny.originalFontSize, 12, 'E11 小于下限钳到 12');
  eq(tiny.translationFontSize, 64, 'E12 大于上限钳到 64');

  ok(reading.needsCompactChrome(25) === false, 'E13 25px 还不算大字模式');
  ok(reading.needsCompactChrome(26) === true, 'E14 26px 起切大字模式（底栏精简）');
  ok(reading.needsMinimalChrome(39) === false, 'E15 39px 还没到极简档');
  ok(reading.needsMinimalChrome(40) === true, 'E16 40px 起连「更多」一起收起');

  const normal = reading.contrastOf(
    reading.TEXT_TOKENS.normal.translation.color,
    reading.TEXT_TOKENS.normal.translation.alpha,
    reading.TEXT_TOKENS.normal.background,
  );
  const high = reading.contrastOf(
    reading.TEXT_TOKENS.high.translation.color,
    reading.TEXT_TOKENS.high.translation.alpha,
    reading.TEXT_TOKENS.high.background,
  );
  ok(normal >= 4.5, `E17 普通模式译文对比度 ${normal.toFixed(2)}:1 要达 WCAG 正文 4.5:1`);
  ok(high >= 20.9, `E18 高对比译文对比度 ${high.toFixed(2)}:1 要接近 21:1`);
  ok(high > normal, 'E19 高对比必须真的更清楚');

  // 反面对照：旧配色 white/45 的计算值，用来证明这套算法没有虚报。
  const legacyContrast = reading.contrastOf('#ffffff', 0.45, '#0b0e14');
  ok(
    legacyContrast < normal,
    `E20 旧配色 white/45 算得 ${legacyContrast.toFixed(2)}:1，低于新配色的 ${normal.toFixed(2)}:1`,
  );

  // 真实渲染出来的颜色（自检从 getComputedStyle 拿到的就是这种字符串）。
  const parsed = reading.parseCssColor('rgb(255, 255, 255)');
  ok(parsed !== null && parsed.rgb.r === 255 && parsed.alpha === 1, 'E21 解析 rgb() 颜色');
  const parsedAlpha = reading.parseCssColor('rgba(255, 255, 255, 0.55)');
  ok(parsedAlpha !== null && parsedAlpha.alpha === 0.55, 'E22 解析带 alpha 的 rgba()');
  eq(reading.parseCssColor('不是颜色'), null, 'E23 非法颜色返回 null，不瞎猜');
  const cssHigh = reading.contrastOfCss('rgb(255, 255, 255)', 'rgb(0, 0, 0)');
  ok(cssHigh !== null && cssHigh >= 20.9, `E24 真渲染色 白/黑 = ${cssHigh && cssHigh.toFixed(2)}:1`);
  const cssHalf = reading.contrastOfCss('rgba(255, 255, 255, 0.55)', 'rgb(0, 0, 0)');
  ok(
    cssHalf !== null && cssHalf < cssHigh,
    'E25 半透明白必须先把 alpha 合成再算，否则会虚报成纯白的 21:1',
  );
}

// ---------------------------------------------------------------------------
// J. 三类字号独立
// ---------------------------------------------------------------------------
console.log('J. 三类字号独立（互不影响）');
{
  const base = reading.readingPrefs({});
  eq(reading.fontSizeOf(base, 'original'), 18, 'J1 原文默认 18');
  eq(reading.fontSizeOf(base, 'translation'), 24, 'J2 译文默认 24（主阅读对象，最大）');
  eq(reading.fontSizeOf(base, 'romanization'), 18, 'J3 谐音默认 18');

  const bigger = reading.adjustFontSize(base, 'translation', 6);
  eq(bigger.translationFontSize, 30, 'J4 调译文 +6 → 30');
  eq(bigger.originalFontSize, 18, 'J5 调译文不动原文');
  eq(bigger.romanizationFontSize, 18, 'J6 调译文不动谐音');

  const smaller = reading.adjustFontSize(base, 'original', -4);
  eq(smaller.originalFontSize, 14, 'J7 调原文 −4 → 14');
  eq(smaller.translationFontSize, 24, 'J8 调原文不动译文');

  const roman = reading.adjustFontSize(base, 'romanization', 12);
  eq(roman.romanizationFontSize, 30, 'J9 调谐音 +12 → 30');
  eq(roman.translationFontSize, 24, 'J10 调谐音不动译文');

  // 到边界就停，不越界也不回弹。
  const floor = reading.adjustFontSize(base, 'romanization', -99);
  eq(floor.romanizationFontSize, 12, 'J11 一路减小停在下限 12');
  const ceil = reading.adjustFontSize(base, 'original', 999);
  eq(ceil.originalFontSize, 64, 'J12 一路加大停在上限 64');

  // 底栏精简看三者最大值 —— 只调谐音也要能触发，否则大字会把主按钮挤下屏。
  eq(reading.maxFontSize(base), 24, 'J13 maxFontSize 取三者最大');
  eq(reading.maxFontSize(reading.adjustFontSize(base, 'romanization', 20)), 38, 'J14 只调谐音也算进最大值');

  // 三个目标的配置必须齐全且各有一个稳定的 data 属性。
  eq(reading.FONT_TARGETS.length, 3, 'J15 三个可调目标');
  eq(
    reading.FONT_TARGETS.map((t) => t.value),
    ['original', 'translation', 'romanization'],
    'J16 顺序固定，界面 A± 不会串位',
  );
  ok(
    new Set(reading.FONT_TARGETS.map((t) => t.dataAttr)).size === 3,
    'J17 data 属性各不相同，自检能分别点',
  );

  // 「中文近似音」必须和译文分开描述 —— 它是谐音，不是译文也不是拼音。
  const hint = reading.FONT_TARGETS.find((t) => t.value === 'romanization').hint;
  ok(hint.includes('谐音'), 'J18 谐音的说明里写明是谐音');
  ok(hint.includes('不是译文'), 'J19 谐音的说明里写明不是译文');
}

// ---------------------------------------------------------------------------
// K. 音源切换进配置指纹 + 启动回执作废
// ---------------------------------------------------------------------------
console.log('K. 音源切换与启动回执');
{
  const base = {
    mockMode: false,
    captureSystemAudio: true,
    captureMicrophone: true,
    deviceId: 'default',
    micId: 'default',
    pythonPath: '',
    demoAutoPlay: false,
    targetLanguage: 'English',
    sttProvider: 'siliconflow',
    sourceMode: 'online',
  };
  const online = gate.pipelineSignature(base);
  const onsite = gate.pipelineSignature({ ...base, sourceMode: 'onsite' });
  ok(online !== onsite, 'K1 用途（线上/现场）必须进指纹，否则切了不会重建、路由还是旧的');

  // 只采系统声音时，麦克风用途根本不影响采集，改它不该白重启一次引擎。
  const sysOnly = gate.pipelineSignature({
    ...base,
    captureMicrophone: false,
    sourceMode: 'online',
  });
  const sysOnlyOnsite = gate.pipelineSignature({
    ...base,
    captureMicrophone: false,
    sourceMode: 'onsite',
  });
  eq(sysOnly, sysOnlyOnsite, 'K2 不采麦克风时，用途变化不该重建引擎');

  // 启动回执多了一种「这次请求已作废」，它既不算成功也不算失败。
  ok(gate.startSucceeded({ ok: true, kind: 'running' }), 'K3 running 算成功');
  ok(gate.startSucceeded({ ok: true, kind: 'skipped' }), 'K4 skipped 算成功（配置没变）');
  ok(!gate.startSucceeded({ ok: false, kind: 'cancelled' }), 'K5 cancelled 不算成功');
  ok(!gate.startSucceeded({ ok: false, kind: 'failed' }), 'K6 failed 不算成功');
  ok(!gate.startSucceeded({ ok: false, kind: 'pending' }), 'K7 pending 不算成功（还在等设备）');
}

// ---------------------------------------------------------------------------
// L. 历史记录纯函数
// ---------------------------------------------------------------------------
console.log('L. 历史记录（错误说明 / 标题 / 导出文本）');
{
  const disk = history.describeHistoryError(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
  ok(Boolean(disk.code), 'L1 磁盘满有独立错误码');
  ok(Boolean(disk.title) && Boolean(disk.hint), 'L2 磁盘满要说清「怎么办」');
  ok(!disk.hint.includes('ENOSPC'), 'L3 给用户的话里不放原始系统错误');

  const notReady = history.describeHistoryError({ code: 'not-ready' });
  ok(notReady.code === 'not-ready', 'L4 数据库没打开有专门的码');
  const unknown = history.describeHistoryError('随便一个字符串');
  eq(unknown.code, 'unknown', 'L5 认不出来的一律 unknown，不假装知道原因');

  // 标题从第一句有意义的话里取，且要能区分不同会话。
  const t1 = history.deriveSessionTitle(['Please send the report by 3 p.m. tomorrow.'], 1);
  ok(t1.length > 0 && t1.length <= 40, 'L6 标题不为空且不超长');
  const t2 = history.deriveSessionTitle(['The meeting moved to Thursday.'], 1);
  ok(t1 !== t2, 'L7 不同内容得到不同标题');
  const t3 = history.deriveSessionTitle([], 1);
  ok(t3.length > 0, 'L8 空会话也要有个标题，不能是空白行');

  const msg = {
    id: 'm1',
    sessionId: 's1',
    seq: 1,
    ts: 1700000000000,
    speaker: 'foreign',
    source: 'system',
    original: 'The budget is fifteen thousand, not fifty thousand.',
    translation: '预算是一万五千，不是五万。',
    romanization: '则 巴 杰 特 一 斯 费 夫 汀 扫 怎 德',
    state: 'final',
  };
  const text = history.messageToText(msg);
  ok(text.includes('fifteen thousand'), 'L9 导出文本保留外语原文');
  ok(text.includes('一万五千'), 'L10 导出文本保留中文译文');
  ok(text.includes('费 夫 汀') || text.includes('谐音'), 'L11 导出文本保留中文谐音（不许丢）');

  const session = {
    id: 's1',
    title: '预算确认',
    language: 'English',
    scenario: 'conversation',
    sourceMode: 'online',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
  const doc = history.sessionToText(session, [msg], []);
  ok(doc.includes('预算确认'), 'L12 导出带上会话标题');
  ok(doc.includes('一万五千'), 'L13 导出带上消息正文');

  const snippet = history.snippetOf(msg, 'fifty');
  ok(snippet.length <= 120, 'L14 搜索结果摘要不超长');
  eq(history.HISTORY_PAGE_SIZE, 50, 'L15 分页大小固定 50（界面文案和代码同一个数）');

  const status = history.emptyHistoryStatus();
  eq(status.ready, false, 'L16 未打开时 ready=false，界面不许显示「已保存」');
  ok(typeof status.lastError === 'string', 'L17 状态里带最近一次错误说明');
}

// ---------------------------------------------------------------------------
// F. 译文四态
// ---------------------------------------------------------------------------
console.log('F. 译文四态');
{
  // 已经有半句译文、整句请求失败 → 必须还算「成功」，不能退回「翻译失败」。
  const partial = subtitleState.translationView({
    translatedText: '请在下午三点前',
    translationState: 'failed',
  });
  eq(partial.state, 'ok', 'F1 已经有译文就算 ok（半句译出不能标成失败）');
  eq(partial.placeholder, null, 'F2 有译文时不显示占位文案');
  eq(partial.canRetry, false, 'F3 有译文时不再催用户重试');

  const failedNoText = subtitleState.translationView({
    translatedText: '',
    translationState: 'failed',
    partial: false,
  });
  eq(failedNoText.state, 'failed', 'F4 没译出才算失败');
  eq(failedNoText.canRetry, true, 'F5 失败必须给逐句重试入口');

  const pending = subtitleState.translationView({
    translatedText: '',
    translationState: 'pending',
    partial: true,
  });
  eq(pending.state, 'pending', 'F6 半句在识别中 → 翻译中');
  eq(pending.placeholder, '翻译中…', 'F7 翻译中的占位文案');

  eq(
    subtitleState.cancelPendingTranslation('pending'),
    'cancelled',
    'F8 停止监听把 pending 转成 cancelled，不是 failed',
  );
  eq(
    subtitleState.cancelPendingTranslation('ok'),
    'ok',
    'F9 已有译文不会被停止监听改成取消',
  );
}

// ---------------------------------------------------------------------------
// G. 沟通卡
// ---------------------------------------------------------------------------
console.log('G. 沟通卡（离线、不联网）');
{
  eq(commCards.COMM_CARDS.length, 3, 'G1 三张卡');
  const ids = commCards.COMM_CARDS.map((item) => item.id);
  eq(ids, ['again', 'slower', 'write'], 'G2 三张卡分别是再说一遍 / 慢一点 / 写下时间');
  for (const card of commCards.COMM_CARDS) {
    ok(/[a-zA-Z]/.test(card.en), `G3 ${card.id} 有英文句子`);
    ok(/[\u4e00-\u9fa5]/.test(card.zh), `G4 ${card.id} 有中文标签`);
    const clip = commCards.cardClipboardText(card);
    ok(clip.includes(card.en), `G5 ${card.id} 复制文本里有英文`);
    ok(/[\u4e00-\u9fa5]/.test(clip), `G6 ${card.id} 复制文本里有中文说明`);
  }

  // 「不联网」不能只写在文案里：源文件里不许出现任何网络调用。
  const distFile = path.join(process.cwd(), 'dist/shared/comm-cards.js');
  const code = fs.readFileSync(distFile, 'utf8');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'https://', 'http://', 'ipcRenderer']) {
    ok(!code.includes(forbidden), `G7 沟通卡模块不许出现 ${forbidden}`);
  }
}

// ---------------------------------------------------------------------------
// H. 三组样例
// ---------------------------------------------------------------------------
console.log('H. 三组样例（规则层，三个语言方向各跑一遍）');
{
  for (const sample of samples.SAMPLE_CASES) {
    for (const [direction, variant] of Object.entries(sample.variants)) {
      // 事实既要能从原话里抓，也要能从译文里抓 —— 两个字段都扫。
      const drafts = facts.extractFactsWithRules({
        originalText: variant.original,
        translatedText: variant.translation,
      });

      for (const want of variant.expect) {
        /*
         * 值会随理解语言变（中文用户看「周四」，英语用户看「Thursday」），
         * 所以按「值 + 原话片段」合起来匹配：两个字段里任一对得上都算抓到。
         */
        const hit = drafts.find((draft) => {
          if (draft.kind !== want.kind) return false;
          const haystack = `${draft.value} ${draft.sourceText}`.toLowerCase();
          if (!haystack.includes(want.includes.toLowerCase())) return false;
          return want.certainty ? draft.certainty === want.certainty : true;
        });
        ok(
          Boolean(hit),
          `H ${sample.id}/${direction} 要抓到 ${want.kind}「${want.includes}」${want.certainty ? `（${want.certainty}）` : ''}`,
          JSON.stringify(drafts.map((d) => `${d.kind}:${d.value}/${d.sourceText}:${d.certainty}`)),
        );
      }

      for (const forbidden of variant.forbidValues || []) {
        // 被否定的旧值可以出现，但必须带着「已更正 / 被否定」的状态。
        const bad = drafts.find(
          (draft) =>
            `${draft.value} ${draft.sourceText}`.toLowerCase().includes(forbidden.toLowerCase()) &&
            draft.certainty !== 'corrected',
        );
        ok(!bad, `H ${sample.id}/${direction} 不许把「${forbidden}」当成确定值原样摆出来`);
      }
    }
  }

  // 逐条钉死关键点，避免「碰巧通过」。
  const moved = facts.extractFactsWithRules({
    originalText: 'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
  });
  const tuesday = moved.find((d) => d.value.includes('Tuesday'));
  ok(Boolean(tuesday), 'H1 否定句里的周二也要留一条');
  eq(tuesday?.certainty, 'corrected', 'H2 周二要标成「已更正」而不是确定性日期');
  /*
   * 0.6.1 起不在值里拼「不是」了：这条事实要同时给中文、日语、英语使用者看，
   * 「不是火曜日」这种半中半外的东西读不了。否定改成结构化字段 `negated`，
   * 界面用当前语言写「被否定」并划掉旧值。
   */
  eq(tuesday?.negated, true, 'H3 周二要带 negated 标记（界面据此说「被否定」）');
  ok(!tuesday?.value.includes('不是'), 'H3b 值里不再混进中文「不是」前缀');
  const thursday = moved.find((d) => d.value.includes('Thursday'));
  ok(thursday && thursday.certainty !== 'corrected', 'H4 改到周四这条不能也带否定');
  ok(
    moved.some((d) => d.kind === 'time' && d.value.includes('10:30')),
    'H5 带点缩写的 10:30 a.m. 要能认出来',
  );

  const budget = facts.extractFactsWithRules({
    originalText: 'The budget is fifteen thousand, not fifty thousand.',
  });
  const fifteen = budget.find((d) => d.value.includes('fifteen thousand'));
  const fifty = budget.find((d) => d.value.includes('fifty thousand'));
  ok(fifteen && fifty, 'H6 一万五和五万两条都要留着（不要只留一个）');
  eq(fifteen?.certainty, 'stated', 'H7 「一万五」是对方给的确定值，不该带上否定');
  eq(fifty?.certainty, 'corrected', 'H8 五万是「不是」的那个');

  const relative = facts.extractFactsWithRules({
    originalText: 'Please send the report by 3 p.m. tomorrow.',
  });
  ok(
    relative.every((d) => !/\d{4}-\d{2}-\d{2}/.test(d.value)),
    'H9 「明天」不许被换算成具体日期',
  );
}

// ---------------------------------------------------------------------------
// I. 错误结构化
// ---------------------------------------------------------------------------
console.log('I. 错误结构化（不带服务商原文）');
{
  const info = aiErrors.describeAiError(
    Object.assign(new Error('HTTP 402: {"error":"insufficient balance"}'), { status: 402 }),
  );
  ok(Boolean(info.code), 'I1 有错误码');
  ok(Boolean(info.title) && Boolean(info.hint), 'I2 有标题和下一步');

  const user = aiErrors.toUserError({ ...info, raw: 'sk-secret-123456' });
  eq(user.code, info.code, 'I3 保留错误码');
  ok(!('raw' in user), 'I4 交给界面的错误里不许带 raw');
  ok(!JSON.stringify(user).includes('sk-'), 'I5 序列化后也不许出现 Key 片段');
  ok(!JSON.stringify(user).includes('insufficient'), 'I6 不许把服务商原文透给用户');
}

console.log(
  failed === 0 ? `\nRESULT PASS ${total}/${total}` : `\nRESULT FAIL ${failed}/${total}`,
);
process.exit(failed === 0 ? 0 : 1);
