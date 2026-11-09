/**
 * 关键事实 / 近音一致性硬化回归（**纯文本层**）。
 *
 * 诚实边界（必须先看）：
 *  - 这里全部是「给定一段文本 → 纯函数输出」的**文本夹具**。
 *  - 没有真实语音、没有合成语音（TTS）、没有调用任何识别模型，也没有伪造
 *    「语音识别结果」。口音/拼写变体、噪声重复片段、无声音、识别失败这几组
 *    只是构造了对应的**文本输入**来验证纯函数行为，不代表模型准确率。
 *  - 文本测试 / 合成语音 / 真实语音三者**不能互相替代**：本轮只完成文本层。
 *  - 「有测试」不等于「模型准确率达标」，本文件不做任何准确率声明。
 *
 * 覆盖：
 *  样例 A  450/540 欧元与周五/周四的否定关系，被否定的值不进确认句；
 *  样例 B  four twenty in the afternoon → 周三下午 4:20（16:20），
 *          定金 300 欧元 / 余款 900 欧元分开说，4.20 不被当成金额、不被当成
 *          凌晨，时间等价表达不误报冲突，无法确定时给澄清提示；
 *  样例 C  中文原话转英语确认句时数字 / 币种 / 否定关系保留，英文句不夹中文；
 *  文本夹具：口音·拼写变体、噪声重复片段、无声音、识别失败（空文本）；
 *  近音：数字与币种都有读音、英文句不混入中文展示值；
 *  版本闸门：原文或事实被改，旧近音 / 旧回复结果必须失效。
 *
 * 运行：node .dev/fidelity-hardening-unit.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nc = require('../dist/shared/numeric-check.js');
const facts = require('../dist/shared/facts.js');
const rp = require('../dist/shared/reply-plan.js');
const cp = require('../dist/shared/caption-pipeline.js');
const pron = require('../dist/services/pronunciation.js');

const {
  scanTimes, scanNumbers, checkNumericConsistency,
} = nc;
const {
  extractFactsWithRules, planConfirmSentence, valueNumbers,
} = facts;
const { planReplies, replyFingerprint, REPLY_VERSION } = rp;
const {
  transliterate, missingNumberHints, buildHintPlan, hintLooksWrong, HINT_VERSION,
} = pron;

const CJK = /[\u3400-\u9fff]/;
const phon = (text) => transliterate(text, 'English');

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail !== undefined ? `  →  ${JSON.stringify(detail)}` : ''}`);
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function factsOf(original) {
  return extractFactsWithRules({ originalText: original, translatedText: '' });
}
function planOf(original) {
  const f = factsOf(original);
  return {
    facts: f,
    plan: planConfirmSentence(
      f.map((fact, index) => ({ ...fact, id: String(index) })),
      'English',
      'Chinese',
    ),
  };
}
function repliesOf(original) {
  const f = factsOf(original);
  const input = { original, translation: '', facts: f, sourceLanguage: 'en' };
  return { facts: f, input, replies: planReplies(input, phon) };
}

const A_SRC = 'The deposit is 450 euros, not 540 euros. The balance is due on Friday, not Thursday.';
const B_SRC = 'The appointment is on Wednesday at four twenty in the afternoon, not Thursday. The deposit is three hundred euros. The remaining balance is nine hundred euros. Please confirm the time and the amounts.';
const C_SRC = '请确认定金是450欧元，不是540欧元，余款周五支付。';

/* ------------------------------------------------------------------ */
/* A 组：450 欧元 / 周五有效；540 欧元 / 周四被否定，不进确认句           */
/* ------------------------------------------------------------------ */
{
  const { facts: f, plan } = planOf(A_SRC);
  const money = f.filter((x) => x.kind === 'money');
  const dates = f.filter((x) => x.kind === 'date');

  ok('A1 两条金额都提取到', money.length === 2, money.map((x) => x.value));
  ok('A2 450 欧元是当前值、未被否定',
    money.some((x) => /450/.test(x.value) && !x.negated), money.map((x) => [x.value, x.negated]));
  ok('A3 540 欧元被标为 negated/corrected',
    money.some((x) => /540/.test(x.value) && x.negated === true), money.map((x) => [x.value, x.negated]));
  ok('A4 币种从原话读到 EUR，不擅自补',
    money.every((x) => x.currency === 'EUR'), money.map((x) => x.currency));
  ok('A5 周五是当前值、周四被否定',
    dates.some((x) => /Friday/i.test(x.value) && !x.negated) &&
      dates.some((x) => /Thursday/i.test(x.value) && x.negated === true),
    dates.map((x) => [x.value, x.negated]));
  ok('A6 确认句含 450 与 Friday', plan.ok && /450/.test(plan.sentence) && /Friday/.test(plan.sentence), plan.sentence);
  ok('A7 确认句不含被否定的 540 与 Thursday',
    plan.ok && !/540/.test(plan.sentence) && !/Thursday/.test(plan.sentence), plan.sentence);
  ok('A8 确认句不夹中文展示值', plan.ok && !CJK.test(plan.sentence), plan.sentence);
  const { replies } = repliesOf(A_SRC);
  ok('A9 回复卡英文句都不夹中文', replies.every((r) => !CJK.test(r.en)), replies.map((r) => r.en));
}

/* ------------------------------------------------------------------ */
/* B 组：周三下午 4:20，定金 300 欧元 / 余款 900 欧元                     */
/* ------------------------------------------------------------------ */
{
  const { facts: f, plan } = planOf(B_SRC);
  const money = f.filter((x) => x.kind === 'money');
  const times = f.filter((x) => x.kind === 'time');

  ok('B1 时间被识别成事实（four twenty in the afternoon）',
    times.some((x) => /four twenty/i.test(x.value) && /afternoon/i.test(x.value)),
    times.map((x) => x.value));
  ok('B2 定金与余款是两条独立金额', money.length === 2, money.map((x) => x.value));
  ok('B3 两笔钱都带原话里的叫法（deposit / remaining balance）',
    money.some((x) => x.label === 'deposit') && money.some((x) => x.label === 'remaining balance'),
    money.map((x) => x.label));
  ok('B4 币种 EUR 从原话读到，不擅自补', money.every((x) => x.currency === 'EUR'), money.map((x) => x.currency));
  eq('B5 three hundred euros 归一为 300', valueNumbers('three hundred euros'), [300]);
  eq('B6 nine hundred euros 归一为 900', valueNumbers('nine hundred euros'), [900]);
  ok('B7 周三有效、周四被否定',
    f.some((x) => x.kind === 'date' && /Wednesday/i.test(x.value) && !x.negated) &&
      f.some((x) => x.kind === 'date' && /Thursday/i.test(x.value) && x.negated === true),
    f.filter((x) => x.kind === 'date').map((x) => [x.value, x.negated]));
  ok('B8 确认句不念被否定的周四', plan.ok && !/Thursday/.test(plan.sentence), plan.sentence);
  ok('B9 确认句不夹中文展示值', plan.ok && !CJK.test(plan.sentence), plan.sentence);

  // 时间归一化：4:20 p.m. ↔ four twenty ↔ 16:20 ↔ 4.20 in the afternoon
  const variants = ['4:20 p.m.', '4.20 in the afternoon', 'four twenty in the afternoon', '16:20'];
  for (const text of variants) {
    eq(`B10 时间写法归一到 16:20：${text}`,
      scanTimes(text).hits.map((h) => `${h.hour}:${h.minute}`), ['16:20']);
  }
  const equivalents = [
    ['four twenty in the afternoon', '下午4点20分'],
    ['four twenty in the afternoon', '4:20 p.m.'],
    ['16:20', 'four twenty in the afternoon'],
    ['4:20 p.m.', '16:20'],
    ['4.20 in the afternoon', '下午4点20分'],
  ];
  for (const pair of equivalents) {
    const r = checkNumericConsistency(pair[0], pair[1]);
    ok(`B11 时间等价不误报冲突：${pair[0]} ↔ ${pair[1]}`, r.level === 'ok', r.message);
  }

  // 4.20 不是金额、不是凌晨 4:20；无法确定时给澄清提示，不擅自补时间
  eq('B12 裸 4.20 不进数值集（没被当成金额）',
    scanNumbers('4.20', scanTimes('4.20').spans).map((h) => h.value), []);
  {
    const r = checkNumericConsistency('4.20', '下午4点20分');
    ok('B13 裸 4.20 给澄清提示', r.message.includes('上午还是下午'), r.message);
    ok('B14 裸 4.20 不硬说成「凌晨4点20分」', !r.message.includes('凌晨'), r.message);
  }
  {
    const f420 = factsOf('at 4.20 in the afternoon the deposit is 300');
    const m = f420.filter((x) => x.kind === 'money');
    ok('B15 时间语境下 4.20 不进金额，只有 300 是金额',
      m.length === 1 && /300/.test(m[0].value) && m.every((x) => !/4\.20/.test(x.value)),
      m.map((x) => x.value));
    ok('B16 4.20 in the afternoon 被识别成时间事实',
      f420.some((x) => x.kind === 'time' && /4\.20/.test(x.value) && /afternoon/.test(x.value)),
      f420.map((x) => [x.kind, x.value]));
  }

  // 回复句不把时间与 300/900 混在一起
  const { replies } = repliesOf(B_SRC);
  const first = replies[0]?.en ?? '';
  ok('B17 回复首卡把定金与余款分开说',
    /the deposit is three hundred euros/.test(first) &&
      /the remaining balance is nine hundred euros/.test(first), first);
  ok('B18 回复首卡不混入时间片段', !/four twenty|4\.20|16:20/i.test(first), first);
  ok('B19 回复卡英文句都不夹中文', replies.every((r) => !CJK.test(r.en)), replies.map((r) => r.en));
}

/* ------------------------------------------------------------------ */
/* C 组：中文原话 → 英语确认句，数字 / 币种 / 否定关系保留               */
/* ------------------------------------------------------------------ */
{
  const { facts: f, plan } = planOf(C_SRC);
  const money = f.filter((x) => x.kind === 'money');
  ok('C1 450 欧元有效、540 欧元被否定',
    money.some((x) => /450/.test(x.value) && !x.negated) &&
      money.some((x) => /540/.test(x.value) && x.negated === true),
    money.map((x) => [x.value, x.negated]));
  ok('C2 币种 EUR 从中文原话读到', money.every((x) => x.currency === 'EUR'), money.map((x) => x.currency));
  ok('C3 周五作为有效日期保留', f.some((x) => /周五/.test(x.value) && !x.negated), f.map((x) => x.value));
  ok('C4 英文确认句用 450 euros / Friday，数字币种保留',
    plan.ok && /450 euros/.test(plan.sentence) && /Friday/.test(plan.sentence), plan.sentence);
  ok('C5 英文确认句不夹中文展示值（不是 450欧元 / 周五）',
    plan.ok && !CJK.test(plan.sentence), plan.sentence);
  ok('C6 英文确认句不念被否定的 540', plan.ok && !/540/.test(plan.sentence), plan.sentence);

  const { replies } = repliesOf(C_SRC);
  ok('C7 所有英文回复卡都不夹中文', replies.every((r) => !CJK.test(r.en)), replies.map((r) => r.en));
  ok('C8 否定关系在回复里保留（not 540 euros）',
    replies.some((r) => /not 540 euros/.test(r.en)), replies.map((r) => r.en));

  // 近音必须覆盖数字与币种
  const hint = phon('450 euros');
  ok('C9 近音含 450 的英语读法', hint.includes('佛 汉卓德 菲夫提'), hint);
  ok('C10 近音不静默丢掉数字', missingNumberHints('450 euros', hint).length === 0,
    missingNumberHints('450 euros', hint));
  ok('C11 币种 euros 也有近音（非空）', hint.length > '佛 汉卓德 菲夫提'.length, hint);
}

/* ------------------------------------------------------------------ */
/* D 组：文本夹具（不是真实音频 / 不是合成语音 / 不是真实识别结果）         */
/* ------------------------------------------------------------------ */
{
  // D1 口音 / 拼写变体：同一时刻的不同转写拼写都归一到 16:20（纯文本夹具）
  const spellings = ['4:20 p.m.', '4.20 in the afternoon', 'four twenty in the afternoon', '16:20'];
  eq('D1 转写拼写变体全部归一到 16:20',
    spellings.map((t) => scanTimes(t).hits[0] && `${scanTimes(t).hits[0].hour}:${scanTimes(t).hits[0].minute}`),
    ['16:20', '16:20', '16:20', '16:20']);
  // 拼写变体的近音与正词一致（文本夹具，非真人发音验证）
  eq('D2 拼写变体 hellow 与 hello 近音一致',
    phon('hellow'), phon('hello'));

  // D3 噪声导致的重复片段：相邻切片重复上一句，去重后不重复上屏
  eq('D3 完全重复的片段被去重', cp.dedupeSegment(['The deposit is 450 euros.'], 'The deposit is 450 euros.'), '');
  ok('D4 重叠片段被裁掉，不把 450 euros 再念一遍',
    !/450 euros/.test(cp.trimOverlap('the deposit is 450 euros', '450 euros and the balance is 900')),
    cp.trimOverlap('the deposit is 450 euros', '450 euros and the balance is 900'));

  // D5 无声音：全零 PCM 判静音，空文本不产出句子（不凭空生成字幕）
  ok('D5 静音 PCM 判为无声', cp.isSilent(new Float32Array(1024)) === true);
  eq('D6 空文本不产出句子', cp.splitSentences(''), { sentences: [], rest: '' });

  // D7 识别失败 / 空识别文本：不生成任何字幕文本
  eq('D7 空识别文本被去重为空', cp.dedupeSegment([], ''), '');
  eq('D8 空识别文本断句为空', cp.splitSentences('').sentences, []);
}

/* ------------------------------------------------------------------ */
/* E 组：版本闸门 —— 原文或事实被改，旧近音 / 旧回复结果必须失效           */
/* ------------------------------------------------------------------ */
{
  // 近音：现成闸门 HINT_VERSION + 基于原文范围的片段 id
  eq('E1 提示带算法版本', HINT_VERSION, 2);
  const plan = buildHintPlan('Please send the report.', 'English', 'hanzi');
  eq('E2 计划里带同一版本', plan.version, HINT_VERSION);
  eq('E3 片段 id 用原文范围', plan.segments[0].id, '0-6');
  const changed = buildHintPlan('Please send the file.', 'English', 'hanzi');
  const oldIds = new Set(plan.segments.map((s) => s.id));
  const misplaced = changed.segments.filter(
    (s) => oldIds.has(s.id) && 'Please send the report.'.slice(s.from, s.to) !== s.source,
  );
  eq('E4 原文改写后没有错位的旧片段', misplaced.length, 0);
  ok('E5 无关读音不能冒充这句原文的近音',
    hintLooksWrong('banana', 'Please send the report.', 'English', 'hanzi'));

  // 回复：REPLY_VERSION + replyFingerprint（本轮补的最小实现）
  eq('E6 回复算法版本', REPLY_VERSION, 1);
  const { input, replies } = repliesOf(A_SRC);
  const key = replyFingerprint(input);
  ok('E7 相同输入指纹稳定', key === replyFingerprint({ ...input }), key);
  ok('E8 原文一改指纹就变（旧回复失效）',
    key !== replyFingerprint({ ...input, original: `${A_SRC} One more thing.` }));
  ok('E9 事实一改指纹就变（旧回复失效）',
    key !== replyFingerprint({
      ...input,
      facts: input.facts.map((x) => ({ ...x, value: `${x.value}x` })),
    }));
  ok('E10 每张回复卡都带上输入指纹',
    replies.length > 0 && replies.every((r) => r.sourceKey === key),
    replies.map((r) => r.sourceKey));
}

console.log(`\n[fidelity-hardening] 通过 ${pass} 条，失败 ${failures.length} 条`);
if (failures.length) {
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exitCode = 1;
}
