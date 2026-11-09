/**
 * P0 事实保真回归：金额币种 / 改期 / 否定（2026-11-09 用户报告的三句 + 变体）。
 *
 * 三句原例（用户提供的验收句）：
 *   A `The deposit is 300 and the remaining balance is 900.`
 *      —— 旧版译文补「美元」、信息卡把「300美元」标成原话、确认句夹中文金额。
 *   B `The rehearsal has moved from Wednesday morning to Friday afternoon.
 *      It will still last ninety minutes.`
 *      —— 旧版译成「从…到…」听不出改期；周三周五同时当当前安排。
 *   C `The appointment is at 4:20 p.m. on Wednesday, not Thursday.`
 *      —— 这句旧版是对的，钉住不许倒退。
 *
 * 变体换金额、币种、日期、否定和改期说法 —— 规则要认的是**形态**，不是这三句。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractFactsWithRules,
  planConfirmSentence,
} = require('../dist/shared/facts.js');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? `\n  got  ${JSON.stringify(detail)}` : ''}`);
  }
}

function factsOf(original, translated) {
  return extractFactsWithRules({ originalText: original, translatedText: translated ?? '' });
}

/** 提取事实并生成英文确认句（理解语言=中文）。 */
function planOf(original, translated) {
  const facts = factsOf(original, translated);
  return {
    facts,
    plan: planConfirmSentence(
      facts.map((fact, index) => ({ ...fact, id: String(index) })),
      'English',
      'Chinese',
    ),
  };
}

/* ------------------------------------------------------------------ */
/* A. 金额与币种                                                        */
/* ------------------------------------------------------------------ */

{
  // 原例：无币种。事实值只能是原话里的裸数字，币种必须是「未说明」。
  const { facts, plan } = planOf(
    'The deposit is 300 and the remaining balance is 900.',
    '存款300美元,剩余余额900美元。',
  );
  const money = facts.filter((f) => f.kind === 'money');
  ok('A1 原例：两条金额都从原话提取', money.length === 2, money.map((f) => f.value));
  ok(
    'A2 原例：值不带币种（原话没说就不能有）',
    money.every((f) => !/美元|美金|人民币|dollar/i.test(f.value)),
    money.map((f) => f.value),
  );
  ok(
    'A3 原例：原话片段是真实英文',
    money.every((f) => f.sourceField === 'original' && /^\d+$/.test(f.sourceText)),
    money.map((f) => f.sourceText),
  );
  ok(
    'A4 原例：币种字段为空（界面据此写「币种未说明」）',
    money.every((f) => f.currency == null),
    money.map((f) => f.currency),
  );
  ok(
    'A5 原例：确认句保留定金与余款并问币种',
    plan.ok &&
      /deposit is 300/.test(plan.sentence) &&
      /remaining balance is 900/.test(plan.sentence) &&
      /[Ww]hat currency/.test(plan.sentence),
    plan.sentence,
  );
  ok(
    'A6 原例：确认句是完整英语，不夹中文值',
    plan.ok && !/美元|人民币|块钱/.test(plan.sentence),
    plan.sentence,
  );
  ok(
    'A7 原例：中文释义说「币种未说明」',
    plan.ok && /币种未说明/.test(plan.meaning),
    plan.meaning,
  );
}

{
  // 变体 A-v1：换了数字与角色（报名费 / 尾款），句式不变。
  const { facts, plan } = planOf(
    'The registration fee is 450 and the final payment is 1,200.',
    '报名费是450美元,尾款是1,200美元。',
  );
  const money = facts.filter((f) => f.kind === 'money');
  ok('A-v1a 变体：两条金额都提取', money.length === 2, money.map((f) => f.value));
  ok(
    'A-v1b 变体：确认句带新数字并问币种',
    plan.ok && /450/.test(plan.sentence) && /1,?200/.test(plan.sentence) && /[Ww]hat currency/.test(plan.sentence),
    plan.sentence,
  );
}

{
  // 变体 A-v2：原话**有**币种时必须保留，且不问币种。
  const { facts, plan } = planOf(
    'The deposit is 300 dollars and the remaining balance is 900 dollars.',
    '存款300美元,剩余余额900美元。',
  );
  const money = facts.filter((f) => f.kind === 'money');
  ok(
    'A-v2a 原话说美元：币种读到 dollars',
    money.length === 2 && money.every((f) => /dollar/i.test(String(f.sourceText))),
    money.map((f) => f.sourceText),
  );
  ok(
    'A-v2b 原话说美元：确认句不必再问币种',
    plan.ok && !/[Ww]hat currency/.test(plan.sentence),
    plan.sentence,
  );
}

{
  // 变体 A-v3：拼写金额，同样无币种。
  const { facts, plan } = planOf(
    'The total price is two hundred and the rest is eighty.',
    '总价200元,其余80元。',
  );
  const money = facts.filter((f) => f.kind === 'money');
  ok(
    'A-v3a 拼写金额：不带货币词时不冒充知道币种',
    money.every((f) => f.currency == null),
    money.map((f) => f.currency),
  );
  ok(
    'A-v3b 拼写金额：确认句不夹中文',
    !plan.sentence || !/美元|人民币/.test(plan.sentence),
    plan.sentence,
  );
}

/* ------------------------------------------------------------------ */
/* B. 改期                                                              */
/* ------------------------------------------------------------------ */

{
  const { facts, plan } = planOf(
    'The rehearsal has moved from Wednesday morning to Friday afternoon. It will still last ninety minutes.',
    '排练从星期三上午到星期五下午,仍持续90分钟。',
  );
  const dates = facts.filter((f) => f.kind === 'date');
  ok('B1 原例：两个日期都在', dates.length === 2, dates.map((f) => f.value));
  const origin = dates.find((f) => f.role === 'origin');
  const current = dates.find((f) => f.role === 'current');
  ok('B2 原例：周三标为原安排（不是当前）', Boolean(origin) && /星期三|周三|Wednesday/.test(origin.value), dates.map((f) => [f.value, f.role]));
  ok('B3 原例：周五标为现安排', Boolean(current) && /星期五|周五|Friday/.test(current.value), dates.map((f) => [f.value, f.role]));
  ok('B4 原例：时长单独成卡', facts.some((f) => f.role === 'duration'), facts.map((f) => [f.kind, f.role]));
  ok(
    'B5 原例：确认句表达「改到」而非并列',
    plan.ok && /now on Friday afternoon instead of Wednesday morning|now Friday afternoon instead of Wednesday morning/i.test(plan.sentence),
    plan.sentence,
  );
  ok(
    'B6 原例：确认句带时长 ninety minutes',
    plan.ok && /ninety minutes/.test(plan.sentence),
    plan.sentence,
  );
  ok(
    'B7 原例：旧时间只在「instead of」里出现一次，不另列',
    plan.ok &&
      (plan.sentence.match(/Wednesday morning/g) ?? []).length === 1 &&
      /instead of Wednesday morning/.test(plan.sentence),
    plan.sentence,
  );
}

{
  // 变体 B-v1：换日期与句式（rescheduled … from … to …，一小时）。
  const { facts, plan } = planOf(
    'The class has been rescheduled from Monday evening to Thursday evening, and it will still last one hour.',
    '课程从周一晚上改到周四晚上,仍持续1小时。',
  );
  const dates = facts.filter((f) => f.kind === 'date');
  const origin = dates.find((f) => f.role === 'origin');
  const current = dates.find((f) => f.role === 'current');
  ok('B-v1a 变体：周一=原安排、周四=现安排', /周一|Monday/.test(origin?.value ?? '') && /周四|Thursday/.test(current?.value ?? ''), dates.map((f) => [f.value, f.role]));
  ok(
    'B-v1b 变体：确认句仍是「instead of」结构',
    plan.ok && /Thursday evening instead of Monday evening/i.test(plan.sentence),
    plan.sentence,
  );
}

{
  // 变体 B-v2：只说改到几点（时间角色），没有原时间。
  const { facts } = planOf(
    'The start time has changed to 5 p.m.',
    '开始时间改为下午5点。',
  );
  const times = facts.filter((f) => f.kind === 'time');
  ok(
    'B-v2a 变体：改后的 5 p.m. 是当前时间',
    times.some((f) => /5/.test(f.value) && f.role === 'current'),
    times.map((f) => [f.value, f.role]),
  );
}

/* ------------------------------------------------------------------ */
/* C. 否定                                                              */
/* ------------------------------------------------------------------ */

{
  const { facts, plan } = planOf(
    'The appointment is at 4:20 p.m. on Wednesday, not Thursday.',
    '预约时间是星期三下午4时20分,而不是星期四。',
  );
  const thursday = facts.find((f) => /thursday/i.test(f.value) || /周四/.test(f.value));
  ok('C1 原例：周四在卡上', Boolean(thursday), facts.map((f) => f.value));
  ok('C2 原例：周四带否定标记', thursday?.negated === true, thursday);
  ok(
    'C3 原例：周三不带否定',
    facts.some((f) => /星期三|周三|Wednesday/.test(f.value) && !f.negated),
    facts.map((f) => [f.value, f.negated]),
  );
  ok(
    'C4 原例：确认句不含 Thursday',
    plan.ok && !/Thursday/.test(plan.sentence),
    plan.sentence,
  );
  ok(
    'C5 原例：确认句含 4:20',
    plan.ok && /4:20/.test(plan.sentence),
    plan.sentence,
  );
}

{
  // 变体 C-v1：否定换到时间上。
  const { facts, plan } = planOf(
    'The pickup is at 9 a.m., not 9 p.m.',
    '取货时间是上午9点,不是晚上9点。',
  );
  const times = facts.filter((f) => f.kind === 'time');
  ok(
    'C-v1a 变体：晚 9 点被否定',
    times.some((f) => f.negated && /p\.?m/i.test(f.sourceText)),
    times.map((f) => [f.value, f.negated]),
  );
  ok(
    'C-v1b 变体：确认句只念上午 9 点',
    plan.ok && /9 a\.m/.test(plan.sentence) && !/9 p\.m/.test(plan.sentence),
    plan.sentence,
  );
}

{
  // 变体 C-v2：换日期数字与说法（the 15th, not the 16th）。
  const facts = factsOf('The deadline is the 15th, not the 16th.', '截止日期是15号,不是16号。');
  const negated = facts.filter((f) => f.negated);
  ok('C-v2a 变体：16 号被否定', negated.length >= 1 && negated.some((f) => /16/.test(f.value)), facts.map((f) => [f.value, f.negated]));
  ok(
    'C-v2b 变体：15 号不带否定',
    facts.some((f) => /15/.test(f.value) && !f.negated),
    facts.map((f) => [f.value, f.negated]),
  );
}

/* ------------------------------------------------------------------ */
/* 交叉：改期 + 否定同时出现（旧时间被否定、新时间有效）                    */
/* ------------------------------------------------------------------ */

{
  const { facts, plan } = planOf(
    'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
    '会议不在周二,改到周四上午10点30分了。',
  );
  const tuesday = facts.find((f) => /周二|Tuesday/i.test(f.value));
  const thursday = facts.find((f) => /周四|Thursday/i.test(f.value));
  ok('X1 周二被否定', tuesday?.negated === true, facts.map((f) => [f.value, f.negated]));
  ok('X2 周四是当前安排且不带否定', thursday?.negated !== true && thursday?.role === 'current', facts.map((f) => [f.value, f.role, f.negated]));
  ok('X3 确认句含 Thursday、不含 Tuesday', plan.ok && /Thursday/.test(plan.sentence) && !/Tuesday/.test(plan.sentence), plan.sentence);
}

console.log(`\n通过 ${pass} 条，失败 ${fail} 条`);
if (fail > 0) process.exitCode = 1;
