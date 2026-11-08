/**
 * 时延统计与自适应门槛的单元验证。
 *
 * 为什么用「纯函数 + dist 产物」而不是跑端到端：真实音频链路在沙箱里经常起不来
 * （Electron 侧 spawnSync 被拒），而这两块逻辑恰恰是最需要保证正确的地方 ——
 * 时延统计算错会把人引到错误的优化方向；门槛算错会直接让字幕变少或变多。
 * import dist/ 里的产物 = 验证的就是真正会跑在用户机器上的那份代码。
 *
 * 用法：node .dev/latency-vad-unit.mjs
 */

import {
  emptySnapshot,
  latencyVerdict,
  percentile,
  summarizeLatency,
} from '../dist/shared/latency.js';
import {
  ABSOLUTE_FLOOR,
  LEGACY_CEILING,
  computeThresholds,
  nextRecentPeak,
} from '../dist/shared/adaptive-vad.js';

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  check(label, Object.is(actual, expected), `期望 ${expected}，实际 ${actual}`);
}

/** 门槛是浮点乘出来的（200 × 0.55 = 110.00000000000001），比较必须带容差。 */
function approx(label, actual, expected, tolerance = 1e-6) {
  check(
    label,
    Math.abs(actual - expected) <= tolerance,
    `期望 ${expected}，实际 ${actual}`,
  );
}

function record(overrides = {}) {
  return {
    traceId: 't',
    at: 0,
    speaker: 'foreign',
    partial: false,
    audioMs: 2000,
    sttMs: 1000,
    translateMs: 500,
    chars: 10,
    preview: 'hello',
    ...overrides,
  };
}

// --------------------------------------------------------------------------- //
// 1. 时延统计
// --------------------------------------------------------------------------- //

{
  const snapshot = {
    records: [
      record({ traceId: 'a', audioMs: 2000, sttMs: 1000, translateMs: 500 }),
      record({ traceId: 'b', audioMs: 3000, sttMs: 2000, translateMs: 1000 }),
      // 中途结果不该进统计：它只是让字幕先动起来，代表不了最终体验。
      record({ traceId: 'c', partial: true, audioMs: 1000, sttMs: 9000 }),
    ],
    replyMs: [2000, 4000],
  };
  const s = summarizeLatency(snapshot);

  eq('只统计整句', s.count, 2);
  eq('音频平均', s.audioAvg, 2500);
  eq('识别平均', s.sttAvg, 1500);
  eq('识别 P95', s.sttP95, 2000);
  eq('翻译样本数', s.translateSamples, 2);
  eq('翻译平均', s.translateAvg, 750);
  eq('翻译 P95', s.translateP95, 1000);
  eq('端到端平均', s.e2eAvg, 2250);
  eq('实时率平均', s.rtfAvg, 0.58);
  eq('实时率最差', s.rtfWorst, 0.67);
  eq('回复平均', s.replyAvg, 3000);
  eq('回复样本数', s.replySamples, 2);
}

// 一条翻译都还没回来时，端到端必须是 0（而不是拿识别耗时冒充）。
{
  const s = summarizeLatency({ records: [record({ translateMs: undefined })], replyMs: [] });
  eq('没有译文时端到端为 0', s.e2eAvg, 0);
  eq('没有译文时翻译样本为 0', s.translateSamples, 0);
  eq('仍然统计识别', s.sttAvg, 1000);
}

// 完全没数据时不能崩、也不能算出负数或 NaN。
{
  const s = summarizeLatency(emptySnapshot());
  eq('空快照样本为 0', s.count, 0);
  eq('空快照识别平均为 0', s.sttAvg, 0);
  eq('空快照实时率为 0', s.rtfAvg, 0);
  check('空快照不含 NaN', !Number.isNaN(s.e2eAvg) && !Number.isNaN(s.rtfAvg));
}

// 音频长度为 0 的脏数据不能把实时率算成 Infinity。
{
  const s = summarizeLatency({ records: [record({ audioMs: 0, sttMs: 900 })], replyMs: [] });
  eq('音频为 0 时不计入实时率', s.rtfAvg, 0);
}

eq('percentile 空数组', percentile([], 95), 0);
eq('percentile 单元素', percentile([7], 95), 7);
eq('percentile 上界不越界', percentile([1, 2, 3], 100), 3);

// --------------------------------------------------------------------------- //
// 2. 体检结论的分支顺序
// --------------------------------------------------------------------------- //

{
  eq('没样本 → idle', latencyVerdict(summarizeLatency(emptySnapshot())).level, 'idle');

  // 实时率优先于端到端：跟不上时其他指标再好也没意义。
  const slow = summarizeLatency({
    records: [record({ audioMs: 1000, sttMs: 1300, translateMs: 100 })],
    replyMs: [],
  });
  eq('实时率 1.3 → bad', latencyVerdict(slow).level, 'bad');
  check('结论里点出实时率', latencyVerdict(slow).title.includes('1.30'), latencyVerdict(slow).title);

  const verySlow = summarizeLatency({
    records: [record({ audioMs: 4000, sttMs: 2000, translateMs: 2000 })],
    replyMs: [],
  });
  eq('端到端 4 秒 → bad', latencyVerdict(verySlow).level, 'bad');

  const mid = summarizeLatency({
    records: [record({ audioMs: 4000, sttMs: 1500, translateMs: 1000 })],
    replyMs: [],
  });
  eq('端到端 2.5 秒 → watch', latencyVerdict(mid).level, 'watch');

  const good = summarizeLatency({
    records: [record({ audioMs: 4000, sttMs: 800, translateMs: 400 })],
    replyMs: [],
  });
  eq('端到端 1.2 秒 → ok', latencyVerdict(good).level, 'ok');
}

// 还没有字幕样本、但已经有回复样本：必须把那个真实数字说出来。
// 用户第一次打开「性能」页大概率就是这个状态，只回一句「还没有样本」等于什么都没说。
{
  const onlyReplies = (replyMs) => summarizeLatency({ records: [], replyMs });

  eq('一点样本都没有 → idle', latencyVerdict(onlyReplies([])).level, 'idle');

  // 实测这台机器上真实模型平均 7.3 秒 —— 这是 bad，不是「样本不足」。
  const slowReply = latencyVerdict(onlyReplies([7261, 7261]));
  eq('只有回复样本且很慢 → bad', slowReply.level, 'bad');
  check('标题里带出真实秒数', slowReply.title.includes('7.3 秒'), slowReply.title);

  eq('只有回复样本、中等 → watch', latencyVerdict(onlyReplies([3000])).level, 'watch');
  eq('只有回复样本、很快 → ok', latencyVerdict(onlyReplies([400])).level, 'ok');
}

// 回复这条链路的尾巴必须被点出来：平均 10.5 秒掩盖了"某次卡了 52 秒"。
{
  const withReplies = (records, replyMs) => summarizeLatency({ records, replyMs });

  // 7 条样本里有一条 52.7 秒（超时 + 重试）→ 平均值被拉高，且必须点名最慢值。
  const tailed = summarizeLatency({ records: [], replyMs: [3200, 3300, 3400, 52697, 3500, 3600, 3700] });
  eq('平均值确实被长尾拉高', tailed.replyAvg, 10485);
  eq('P95 抓到那条最长尾', tailed.replyP95, 52697);

  const v = latencyVerdict(tailed);
  eq('回复很慢 → bad', v.level, 'bad');
  check('标题按平均值报', v.title.includes('10.5 秒'), v.title);
  check('正文点出最慢值', v.hint.includes('52.7 秒'), v.hint);

  // 没有长尾（都差不多）→ 不该无中生有地加那句话。
  const flat = latencyVerdict(withReplies([], [3200, 3300, 3400, 3500, 3600]));
  check('没有长尾时不加多余提示', !flat.hint.includes('最慢'), flat.hint);

  // 样本太少时不下"长尾"结论（两条样本谈不上分位数）。
  const few = latencyVerdict(withReplies([], [52697, 3000]));
  check('样本太少时不报长尾', !few.hint.includes('最慢'), few.hint);
}

// 字幕快、回复慢且带长尾：瓶颈结论 + 尾巴提示都要出现。
{
  const s = summarizeLatency({
    records: [record({ audioMs: 4000, sttMs: 800, translateMs: 400 })],
    replyMs: [3200, 3300, 3400, 52697, 3500],
  });
  const v = latencyVerdict(s);
  eq('字幕快 + 回复慢 → bad', v.level, 'bad');
  check('结论指向回复', v.title.includes('生成回复'), v.title);
  check('同时点出长尾', v.hint.includes('52.7 秒'), v.hint);
}
{
  const fastSubtitles = (replyMs) =>
    summarizeLatency({
      records: [record({ audioMs: 4000, sttMs: 800, translateMs: 400 })],
      replyMs,
    });

  const bad = latencyVerdict(fastSubtitles([7000, 7200]));
  eq('字幕快、回复慢 → bad', bad.level, 'bad');
  check('结论指向回复这一环', bad.title.includes('生成回复'), bad.title);

  eq('字幕快、回复偏慢 → watch', latencyVerdict(fastSubtitles([3000])).level, 'watch');

  // 回复慢不该把「字幕本身有问题」这件事盖掉：识别跟不上仍然优先报识别。
  const rtfFirst = latencyVerdict(
    summarizeLatency({
      records: [record({ audioMs: 1000, sttMs: 1300, translateMs: 100 })],
      replyMs: [9000],
    }),
  );
  eq('识别跟不上时仍然先报识别', rtfFirst.level, 'bad');
  check('没被回复抢走结论', rtfFirst.title.includes('识别'), rtfFirst.title);
}

// --------------------------------------------------------------------------- //
// 3. 自适应切句门槛
// --------------------------------------------------------------------------- //

{
  // 正常音量：必须与旧实现完全一致，不能有任何行为变化。
  const loud = computeThresholds(50, 8000);
  eq('正常音量起判门槛 = 旧的 200', loud.start, 200);
  approx('正常音量续判门槛', loud.keep, 110);

  const normal = computeThresholds(30, 1500);
  eq('常见音量起判门槛', normal.start, 200);

  // 安静素材：门槛必须真的降下来，否则整段会被当静音丢掉。
  const quiet = computeThresholds(25, 300);
  check('安静素材门槛显著降低', quiet.start < LEGACY_CEILING, `实际 ${quiet.start}`);
  eq('安静素材起判门槛', quiet.start, 90);

  // 死寂：recentPeak 归零，此时靠底噪兜住，不能低到误触发。
  const silent = computeThresholds(40, 0);
  eq('死寂时起判门槛由底噪兜住', silent.start, 96);
  approx('死寂时续判门槛', silent.keep, 60);

  // 核心不变量：任何情况下都不会比旧实现更严（→ 不会让字幕变少）。
  const legacy = (noiseFloor) => Math.max(LEGACY_CEILING, noiseFloor * 2.4);
  let neverStricter = true;
  let keepAlwaysBelow = true;
  let floorRespected = true;
  for (const noiseFloor of [0, 10, 25, 40, 50, 83, 120, 400, 1500, 6000]) {
    for (const peak of [0, 1, 100, 300, 666, 1000, 5000, 32000]) {
      const { start, keep } = computeThresholds(noiseFloor, peak);
      if (start > legacy(noiseFloor) + 1e-9) neverStricter = false;
      if (!(keep < start)) keepAlwaysBelow = false;
      if (start < ABSOLUTE_FLOOR - 1e-9) floorRespected = false;
    }
  }
  check('门槛永不比旧实现更严（字幕只会变多不会变少）', neverStricter);
  check('续判门槛恒小于起判门槛（不会把一句话切成两半）', keepAlwaysBelow);
  check('起判门槛始终不低于绝对保底', floorRespected);

  // 单调性：最近听到的越响，门槛越高或持平，不会反向。
  let monotonic = true;
  let previous = -Infinity;
  for (const peak of [0, 100, 300, 666, 1000, 3000, 9000, 32000]) {
    const { start } = computeThresholds(30, peak);
    if (start < previous - 1e-9) monotonic = false;
    previous = start;
  }
  check('门槛随近期峰值单调不降', monotonic);
}

// --------------------------------------------------------------------------- //
// 4.5 识别测速的分布（单次结果不可信）
// --------------------------------------------------------------------------- //

{
  // 实测：同一个模型、同一台机器，3 秒音频 381ms ~ 11177ms（差 29 倍）。
  const s = summarizeLatency({ records: [], replyMs: [], probeMs: [381, 1000, 11177] });
  eq('测速样本数', s.probeSamples, 3);
  eq('最新一次是数组头部', s.probeLatest, 381);
  eq('最快', s.probeFastest, 381);
  eq('最慢', s.probeSlowest, 11177);

  // 最慢一次已经比音频本身长 → 还没放视频就该报 bad。
  const v = latencyVerdict(s);
  eq('识别最慢超过音频 → bad', v.level, 'bad');
  check('标题点出倍数', v.title.includes('3.73'), v.title);
  check('正文给出分布', v.hint.includes('11177'), v.hint);

  // 单次测速：可以下结论，但不能编「历次」。
  const one = summarizeLatency({ records: [], replyMs: [], probeMs: [400] });
  eq('只有一次测速', one.probeSamples, 1);
  const vOne = latencyVerdict(one);
  eq('单次测速很快 → ok', vOne.level, 'ok');
  check('单次测速不谈分布', !vOne.hint.includes('历次'), vOne.hint);

  // 接近临界：最慢 2000ms / 3000ms = 0.67 → 能用但要盯着。
  const borderline = latencyVerdict(
    summarizeLatency({ records: [], replyMs: [], probeMs: [2000] }),
  );
  eq('实时率 0.67 → watch', borderline.level, 'watch');

  // 老快照没有 probeMs 字段：不能崩、不能出 NaN。
  const legacy = summarizeLatency({ records: [], replyMs: [] });
  eq('缺字段时测速样本为 0', legacy.probeSamples, 0);
  check(
    '缺字段时不出 NaN',
    !Number.isNaN(legacy.probeLatest) && !Number.isNaN(legacy.probeSlowest),
  );
  eq('emptySnapshot 带 probeMs', emptySnapshot().probeMs.length, 0);

  // 测速样本为 0 的脏数据（例如全 0）不该被当成有效测速。
  const zeros = summarizeLatency({ records: [], replyMs: [], probeMs: [0, 0] });
  eq('全 0 的测速不算样本', zeros.probeSamples, 0);
}

// --------------------------------------------------------------------------- //
// 5. 近期峰值追踪器
// --------------------------------------------------------------------------- //

{
  eq('瞬间抬到当前值', nextRecentPeak(0, 500), 500);
  eq('不跟随下降、只缓慢衰减', nextRecentPeak(500, 0), 490);
  eq('比衰减值大时取大者', nextRecentPeak(1000, 300), 980);
  check('负输入不会污染', nextRecentPeak(200, -50) >= 0);
  check('长时间静音后趋近 0 但不为负', (() => {
    let value = 9000;
    for (let i = 0; i < 500; i += 1) value = nextRecentPeak(value, 0);
    return value >= 0 && value < 1;
  })());
}

// --------------------------------------------------------------------------- //

if (failures.length) {
  console.log(`FAIL  ${passed} 通过，${failures.length} 失败`);
  for (const item of failures) console.log(`  × ${item}`);
  process.exit(1);
}
console.log(`PASS  ${passed}/${passed} 全部通过`);
