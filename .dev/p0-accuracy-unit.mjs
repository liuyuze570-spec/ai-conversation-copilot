/**
 * P0 准确性回归（2026-11-09 用户报的三个问题 + 核心事实形态）。
 *
 *  1. 英文回复写成「450欧元」——中文信息卡的值被直接拼进英语句子；
 *  2. 回复近音把 300 / 900 静默丢掉——`transliterate` 对纯数字返回空串；
 *  3. 大字卡关闭后焦点落到 BODY——这一条只能真浏览器验，见
 *     `webapp/e2e/p0-verify.mjs` 的 R1–R5。
 *
 * 这里验 1、2 和「金额/币种/否定/改期/时长」不倒退。数字近音必须是
 * **英语读法**（three hundred，不是「三零零」），且不能静默省略。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractFactsWithRules, planConfirmSentence } = require('../dist/shared/facts.js');
const { planReplies } = require('../dist/shared/reply-plan.js');
const { transliterate, missingNumberHints } = require('../dist/services/pronunciation.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${name}${detail !== undefined ? `\n  got  ${JSON.stringify(detail)}` : ''}`);
  }
}

const CJK = /[\u3400-\u9fff]/;
const phon = (text) => transliterate(text, 'English');
function repliesOf(original, translated) {
  const facts = extractFactsWithRules({ originalText: original, translatedText: translated });
  return {
    facts,
    replies: planReplies({ original, translation: translated, facts, sourceLanguage: 'en' }, phon),
  };
}

/* ---- 1. 英文回复不得夹中文币种 ---------------------------------------- */
{
  const cases = [
    ['欧元', 'The deposit is 450 euros.', '定金是450欧元。', '450 euros', '450欧元'],
    ['美元', 'The fee is 450 dollars.', '费用是450美元。', '450 dollars', '450美元'],
    ['英镑', 'The rent is 450 pounds.', '租金是450英镑。', '450 pounds', '450英镑'],
    ['日元', 'The total is 450 yen.', '总额是450日元。', '450 yen', '450日元'],
  ];
  for (const [tag, original, translated, expectedEn, expectedZh] of cases) {
    const { replies } = repliesOf(original, translated);
    const first = replies[0]?.en ?? '';
    ok(`${tag}：英文回复用 ${expectedEn}`, first.includes(expectedEn), first);
    ok(`${tag}：英文回复不含中文字符`, replies.every((r) => !CJK.test(r.en)), replies.map((r) => r.en));
    ok(`${tag}：中文展示值仍是 ${expectedZh}`, replies[0]?.zh?.includes(expectedZh.replace(/\D/g, '')) ?? false, replies[0]?.zh);
  }
}

/* ---- 无币种不许补 ------------------------------------------------------ */
{
  const { replies, facts } = repliesOf(
    'The deposit is 300 and the remaining balance is 900.',
    '存款300,剩余余额900。',
  );
  ok('无币种：事实 currency 为 null', facts.filter((f) => f.kind === 'money').every((f) => f.currency == null), facts);
  ok('无币种：英文回复不出现任何币种词', !/dollars|euros|pounds|yen|yuan|美元|欧元/i.test(replies[0]?.en ?? ''), replies[0]?.en);
  ok('无币种：英文回复问币种', /[Ww]hat currency/.test(replies[0]?.en ?? ''), replies[0]?.en);
  ok('无币种：确认句保留两个数字', /300/.test(replies[0]?.en ?? '') && /900/.test(replies[0]?.en ?? ''), replies[0]?.en);
}

/* ---- 2. 数字近音：英语读法 + 不静默省略 -------------------------------- */
{
  const cases = [
    ['300', '斯瑞 汉卓德'],
    ['900', '奈恩 汉卓德'],
    ['450', '佛 汉卓德 菲夫提'],
    ['90', '奈恩提'],
    ['1000', '万 骚怎'],
    ['1,250', '万 骚怎 图 汉卓德 菲夫提'],
    ['12.5', '特外夫 泡因特 法伊夫'],  // point 后逐位念 five，不是 fifty
    ['4:20', '佛 特温提'],
    ['4:05', '佛 欧 法伊夫'],
    ['900.', '奈恩 汉卓德'],   // 句尾标点不能把数字吃掉
    ['$450', '佛 汉卓德 菲夫提'],
  ];
  for (const [token, expected] of cases) {
    const got = transliterate(token, 'English');
    ok(`近音 ${token} → ${expected}`, got === expected, got);
    ok(`近音 ${token} 不是空串`, got.length > 0, got);
  }

  const sentences = [
    'Just to confirm, the deposit is 300 and the remaining balance is 900. What currency are these amounts in?',
    'Just to confirm, the deposit is 450 euros. Is that right?',
    'The appointment is at 4:20 p.m. on Wednesday, not Thursday.',
    'It will still last 90 minutes.',
    'The total is 1,250.50 dollars.',
  ];
  for (const sentence of sentences) {
    const hint = transliterate(sentence, 'English');
    ok(`整句近音没有漏数字：${sentence.slice(0, 34)}…`, missingNumberHints(sentence, hint).length === 0, {
      hint,
      missing: missingNumberHints(sentence, hint),
    });
  }
  // 校验器本身要能抓到「人为删掉数字近音」，否则这道防线是摆设。
  ok(
    'missingNumberHints 能抓到被删掉的数字近音',
    missingNumberHints('the deposit is 300', '德 德波西特 伊兹').includes('300'),
    missingNumberHints('the deposit is 300', '德 德波西特 伊兹'),
  );
  ok(
    '回复卡首卡近音同时覆盖 300 与 900',
    /斯瑞 汉卓德/.test(repliesOf('The deposit is 300 and the remaining balance is 900.', '存款300,余款900。').replies[0].segments.map((s) => s.phon).join(' ')) &&
      /奈恩 汉卓德/.test(repliesOf('The deposit is 300 and the remaining balance is 900.', '存款300,余款900。').replies[0].segments.map((s) => s.phon).join(' ')),
  );
}

/* ---- 3. 核心形态不倒退：否定 / 改期 / 时长 ---------------------------- */
{
  const c = repliesOf(
    'The appointment is at 4:20 p.m. on Wednesday, not Thursday.',
    '预约在星期三下午4点20分,不是星期四。',
  );
  const negated = c.facts.find((f) => f.negated);
  ok('否定：周四被标为不作数', Boolean(negated), c.facts.map((f) => [f.value, f.negated]));
  ok('否定：回复不把周四当有效日期', !/(^|[^t])on Thursday/i.test(c.replies.map((r) => r.en).join(' ')), c.replies.map((r) => r.en));
  const planC = planConfirmSentence(c.facts.map((f, i) => ({ ...f, id: String(i) })), 'English', 'Chinese');
  ok('否定：确认句不出现被否定的周四', planC.ok && !/Thursday/.test(planC.sentence), planC.sentence);

  const b = repliesOf(
    'The rehearsal has moved from Wednesday morning to Friday afternoon. It will still last ninety minutes.',
    '排练由星期三上午改到星期五下午,仍持续90分钟。',
  );
  ok('改期：有 origin / current / duration 三种角色',
    ['origin', 'current', 'duration'].every((role) => b.facts.some((f) => f.role === role)),
    b.facts.map((f) => [f.value, f.role]));
  ok('改期：英文确认句表达变更关系', /instead of/i.test(b.replies[0]?.en ?? ''), b.replies[0]?.en);
  ok('改期：时长仍在英文句里且是英文', /ninety minutes/i.test(b.replies[0]?.en ?? '') && !CJK.test(b.replies[0]?.en ?? ''), b.replies[0]?.en);
  const planB = planConfirmSentence(b.facts.map((f, i) => ({ ...f, id: String(i) })), 'English', 'Chinese');
  ok('改期：确认句不夹中文值', planB.ok && !CJK.test(planB.sentence), planB.sentence);
}

console.log(`\n通过 ${pass} 条，失败 ${fail} 条`);
if (fail > 0) process.exitCode = 1;
