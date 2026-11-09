/**
 * 真实语音识别输出的事实提取回归（ASR 输出形态）。
 *
 * 这些字符串不是编的：它们是 `faster-whisper base` 对四段 SAPI 合成语音
 * 转写的**实际输出**（见 webapp/server/testdata/meta.json）。跑这段测试之前，
 * 三条里有两条是坏的：
 *   - `10.30am` / `4.15pm` 被切成 `30am` / `15pm`（冒号写法的正则不认点）
 *   - `The budget is 15,000, not 50,000.` 一条金额都提不出来（只认带货币符号的）
 * 所以这里钉的不是「规则好看」，是「真实转录进来的字符串能被读懂」。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractFactsWithRules, planConfirmSentence } = require('../dist/shared/facts.js');

let pass = 0;
let fail = 0;
const results = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${name}\n  want ${JSON.stringify(expected)}\n  got  ${JSON.stringify(actual)}`);
  }
}

function factsOf(text) {
  return extractFactsWithRules({ originalText: text, translatedText: '' });
}

function pairs(text) {
  return factsOf(text).map((fact) => [fact.kind, fact.value, Boolean(fact.negated)]);
}

function confirmOf(text) {
  const facts = factsOf(text);
  const plan = planConfirmSentence(
    facts.map((fact) => ({
      value: fact.value,
      sourceText: fact.sourceText,
      negated: fact.negated,
      certainty: fact.certainty,
    })),
    'English',
    'Chinese',
  );
  return plan.ok ? plan.sentence : `BLOCKED:${plan.message}`;
}

// ---- A. 四段真实转录 ---------------------------------------------------------
check('A1 3pm + tomorrow', pairs('Please send the report by 3pm tomorrow.'), [
  ['time', '3pm', false],
  ['date', 'tomorrow', false],
]);
check('A2 10.30am 点号时间', pairs('The meeting is not on Tuesday. It has moved to Thursday at 10.30am.'), [
  ['time', '10.30am', false],
  ['date', 'Tuesday', true],
  ['date', 'Thursday', false],
]);
check('A3 千分位金额与否定', pairs('The budget is 15,000, not 50,000.'), [
  ['money', '15,000', false],
  ['money', '50,000', true],
]);
check('A4 4.15pm + Friday', pairs('I will bring the blue folder to the office at 4.15pm on Friday.'), [
  ['time', '4.15pm', false],
  ['date', 'Friday', false],
]);

// ---- B. 确认句只念当前值 -----------------------------------------------------
check('B1 改期句子确认句含新时间', confirmOf('The meeting is not on Tuesday. It has moved to Thursday at 10.30am.'), 'Just to confirm, 10.30am, Thursday. Is that right?');
check('B2 金额句子不念被否定的旧值', confirmOf('The budget is 15,000, not 50,000.'), 'Just to confirm, 15,000. Is that right?');
check('B3 3pm 句子', confirmOf('Please send the report by 3pm tomorrow.'), 'Just to confirm, 3pm, tomorrow. Is that right?');

// ---- C. 点号时间不能吞掉别的数字 ---------------------------------------------
check('C1 10.30am 只出一条时间', factsOf('It starts at 10.30am.').filter((f) => f.kind === 'time').map((f) => f.value), ['10.30am']);
check('C2 4.15pm 只出一条时间', factsOf('Meet at 4.15pm.').filter((f) => f.kind === 'time').map((f) => f.value), ['4.15pm']);
check('C3 9am 仍认', factsOf('Call me at 9am.').map((f) => f.value), ['9am']);
check('C4 冒号写法不受影响', factsOf('At 10:45 it ends.').map((f) => f.value), ['10:45']);

// ---- D. 千分位只按金额算，普通小数不算 ---------------------------------------
check('D1 一百五十万', factsOf('The total is 1,250,000.').map((f) => [f.kind, f.value]), [['money', '1,250,000']]);
check('D2 价格带符号也认', factsOf('It costs $15,000.').map((f) => [f.kind, f.value]), [['money', '$15,000']]);
check('D3 百分比不当金额', factsOf('About 0.5 percent.').filter((f) => f.kind === 'money'), []);
check('D4 三点五个百分点不误判', factsOf('It grew 2.5 percent.').filter((f) => f.kind === 'money'), []);

// ---- E. 中文侧：认阿拉伯数字与「万/千」量级，纯汉字数字是已知缺口 ---------------
check('E1 阿拉伯数字 + 元', factsOf('预算 15000 元，不是 50000 元。').map((f) => [f.kind, f.value, Boolean(f.negated)]), [
  ['money', '15000 元', false],
  ['money', '50000 元', true],
]);
check('E2 1万5千 / 5万', factsOf('预算是1万5千，不是5万。').map((f) => [f.kind, f.value, Boolean(f.negated)]), [
  ['money', '1万5千', false],
  ['money', '5万', true],
]);
/*
 * 已知缺口：纯汉字数字（一万五千）不提金额。
 * 产品里原话是英语，金额一定先在英文侧命中，所以这条不影响确认句；
 * 但如果哪天只拿到中文译文，这里会空。**这一条如实记录，不标成已支持。**
 */
check('E3 纯汉字数字仍不提取（已知限制）', factsOf('预算是一万五千，不是五万。').map((f) => f.kind), []);

/* ------------------------------------------------------------------ */
/* F. 中英合并：按数值配对，不按数组下标                                  */
/* ------------------------------------------------------------------ */
/*
 * 实测缺陷（2026-11-09）：公网译文 `预算为12 000,而不是2万` 里
 * `12 000` 用空格分千位，旧金额规则只认逗号 → 译文侧只剩 `2万` 一条，
 * 于是它被配给了原文的 `twelve thousand`：
 *   - 卡上「2万」的原话写成「twelve thousand」（来源错配）
 *   - 真正的当前值「一万二」整条消失
 * 用户照着这张卡核对，会确认一个错的数。
 */
{
  const src =
    'Please move the meeting to Friday at 2 p.m. The budget is twelve thousand, not twenty thousand.';
  const facts = extractFactsWithRules({
    originalText: src,
    translatedText: '请将会议移至星期五下午2时。 预算为12 000,而不是2万。',
  });
  const money = facts.filter((f) => f.kind === 'money');

  check('F1 空格千分位被识别为金额', money.length, 2);
  check(
    'F2 当前值一万二在卡上',
    money.filter((f) => !f.negated).map((f) => f.value),
    ['12 000'],
  );
  check(
    'F3 被否定的两万',
    money.filter((f) => f.negated).map((f) => f.value),
    ['2万'],
  );
  // 来源必须对上：两万的原文是 twenty thousand，不是 twelve thousand
  check(
    'F4 来源不错配',
    money.filter((f) => f.negated).map((f) => f.sourceText),
    ['twenty thousand'],
  );
  check(
    'F5 当前值来源正确',
    money.filter((f) => !f.negated).map((f) => f.sourceText),
    ['twelve thousand'],
  );
}

// F6 逗号千分位也必须仍然工作（回归）
{
  const facts = extractFactsWithRules({
    originalText: 'The budget is twelve thousand, not twenty thousand.',
    translatedText: '预算为12,000，而不是20,000。',
  });
  check(
    'F6 逗号千分位',
    facts.filter((f) => f.kind === 'money').map((f) => [f.value, Boolean(f.negated)]),
    [
      ['12,000', false],
      ['20,000', true],
    ],
  );
}

console.log(`\n通过 ${pass} 条，失败 ${fail} 条`);
if (fail > 0) {
  process.exitCode = 1;
  for (const result of results.filter((item) => !item.ok)) {
    console.log(JSON.stringify(result));
  }
}
