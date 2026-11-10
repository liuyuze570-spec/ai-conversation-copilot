/**
 * 课堂事实确认回归（2026-11-10 第二轮根因修复）。
 *
 * 主审真实反例：
 *   `You do not need to submit the essay on Tuesday. Please upload it by
 *    4:20 p.m. on Thursday. Write 450 words, not 540 words.`
 *
 * 修复目标（见「交给WorkBuddy-最终收尾修复提示词」第三节）：
 *   1. 时间归一：`下午4: 20 / 下午4:20 / 下午4点20分 / 16:20 / 4:20 p.m.` 等价；
 *      04:20 与 16:20 仍应判不同；4.20 euros 仍是金额。
 *   2. 否定/无需：`not need to` / `do not have to` / `无需` / `不需要` 按分句作用域；
 *      Tuesday 不能被当成肯定当前截止日。
 *   3. 中英按星期语义配对，不按顺序硬配。
 *   4. 450 words 保留单位，不变成裸 450 或 450 characters。
 *   5. 最终输出校验：英文/中文/复制/大字/朗读共用一份结果，不夹错误日期/单位。
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

function planOf(original, translated) {
  const facts = extractFactsWithRules({ originalText: original, translatedText: translated ?? '' });
  const plan = planConfirmSentence(
    facts.map((fact, index) => ({ ...fact, id: String(index) })),
    'English',
    'Chinese',
  );
  return { facts, plan };
}

/* ------------------------------------------------------------------ */
/* 1. 主审真实反例                                                       */
/* ------------------------------------------------------------------ */
{
  const { facts, plan } = planOf(
    'You do not need to submit the essay on Tuesday. Please upload it by 4:20 p.m. on Thursday. Write 450 words, not 540 words.',
    '您不需要在星期二提交论文。 请在星期四下午4: 20上传。 写450个单词, 而不是540个单字 。',
  );

  // 1a. 周二不能被当成肯定当前截止日
  const tuesday = facts.find((f) => /Tuesday|周二/.test(f.value));
  ok('1a 周二被否定（无需周二交）', tuesday?.negated === true, facts.map((f) => [f.value, f.negated]));

  // 1b. 周四是当前有效截止日（合并后 value 是中文「星期四下午」，sourceText 是英文 Thursday）
  const thursday = facts.find((f) => /星期四/.test(f.value) || /Thursday/.test(f.sourceText));
  ok(
    '1b 周四不带否定',
    Boolean(thursday) && thursday.negated !== true && /Thursday/.test(String(thursday.sourceText)),
    facts.map((f) => [f.value, f.sourceText, f.negated]),
  );

  // 1c. 确认句含 Thursday、不含 Tuesday（除非显式说明无需）
  ok(
    '1c 确认句含 Thursday 不含裸 Tuesday',
    plan.ok && /Thursday/.test(plan.sentence) && !/Tuesday/.test(plan.sentence),
    plan.sentence,
  );

  // 1d. 450 words 保留单位，不裸 450
  ok(
    '1d 确认句保留 450 words 单位',
    plan.ok && /450\s*words/.test(plan.sentence) && !/450(?!\s*words)/.test(plan.sentence.replace(/\s+/g, ' ')),
    plan.sentence,
  );

  // 1e. 540 不默认纳入
  ok('1e 确认句不含 540', plan.ok && !/540/.test(plan.sentence), plan.sentence);

  // 1f. 中文释义与英文星期一致（不夹「星期二」这种被否定的日期）
  ok('1f 释义不夹被否定的星期二', plan.ok && !/星期二/.test(plan.meaning), plan.meaning);
}

/* ------------------------------------------------------------------ */
/* 2. 时间等价表达                                                       */
/* ------------------------------------------------------------------ */
{
  const eq = [
    ['下午4: 20', '请于下午4: 20上传。', 16, 20],
    ['下午4:20', '请于下午4:20上传。', 16, 20],
    ['下午4点20分', '请于下午4点20分上传。', 16, 20],
    ['16:20', '请于16:20上传。', 16, 20],
  ];
  for (const [name, text, hour, minute] of eq) {
    const facts = extractFactsWithRules({ originalText: text, translatedText: '' });
    const time = facts.find((f) => f.kind === 'time');
    ok(
      `2 时间等价 ${name} 提取到时间`,
      Boolean(time),
      facts.map((f) => [f.kind, f.value]),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 3. 三种关系：无需/不要/可以交但周四截止                                 */
/* ------------------------------------------------------------------ */
{
  // 无需周二交
  const a = planOf('You do not need to submit on Tuesday. Please submit by Thursday.', '你不需要周二交，请在周四前交。');
  const aTuesday = a.facts.find((f) => /Tuesday|周二/.test(f.value));
  ok('3a 无需周二交：周二否定', aTuesday?.negated === true, a.facts.map((f) => [f.value, f.negated]));

  // 不要周二交（禁止）
  const b = planOf('Do not submit on Tuesday. Submit by Thursday.', '不要周二交，请在周四前交。');
  const bTuesday = b.facts.find((f) => /Tuesday|周二/.test(f.value));
  ok('3b 不要周二交：周二否定', bTuesday?.negated === true, b.facts.map((f) => [f.value, f.negated]));

  // 周二可以交，但周四截止
  const c = planOf('You can submit on Tuesday, but the deadline is Thursday.', '周二可以交，但截止日是周四。');
  const cTuesday = c.facts.find((f) => /Tuesday|周二/.test(f.value));
  const cThursday = c.facts.find((f) => /Thursday|周四/.test(f.value));
  ok('3c 周二可以交：周二不否定', cTuesday?.negated !== true, c.facts.map((f) => [f.value, f.negated]));
  ok('3d 周四截止：周四不否定', cThursday?.negated !== true, c.facts.map((f) => [f.value, f.negated]));
}

/* ------------------------------------------------------------------ */
/* 4. 改期句保留（已有测试，钉住不倒退）                                  */
/* ------------------------------------------------------------------ */
{
  const { facts, plan } = planOf(
    'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
    '会议不在周二,改到周四上午10点30分了。',
  );
  const tuesday = facts.find((f) => /周二|Tuesday/i.test(f.value));
  ok('4a 改期句周二否定', tuesday?.negated === true, facts.map((f) => [f.value, f.negated]));
  ok('4b 改期句确认不含 Tuesday', plan.ok && !/Tuesday/.test(plan.sentence), plan.sentence);
}

/* ------------------------------------------------------------------ */
/* 5. 否定金额/日期（已有测试）                                          */
/* ------------------------------------------------------------------ */
{
  const { facts, plan } = planOf(
    'The deposit is 450 euros, not 540 euros. The balance is due on Friday, not Thursday.',
    '定金是450欧元,不是540欧元,余款周五支付,不是周四。',
  );
  ok('5a 确认句不含 540', plan.ok && !/540/.test(plan.sentence), plan.sentence);
  ok('5b 确认句不含 Thursday', plan.ok && !/Thursday/.test(plan.sentence), plan.sentence);
  ok('5c 确认句含 Friday', plan.ok && /Friday/.test(plan.sentence), plan.sentence);
}

console.log(`\n课堂回归 通过 ${pass} 条，失败 ${fail} 条`);
if (fail > 0) process.exitCode = 1;
