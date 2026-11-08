/**
 * 确认句的事实一致性（纯函数级）。
 *
 * 这里只测 `shared/facts.ts` 导出的纯逻辑 —— 不碰界面、不碰网络、不碰数据库。
 * 期望值是**独立写的**：句子该念哪个数、释义该显示哪个数，都按「用户改后的
 * 当前理解」来定，不是把程序里的映射表抄一遍当答案。
 *
 * 覆盖用户实测到的那条：
 *   原话 15,000 dollars，用户改成 16000美元
 *   → 以前英文说 15,000、中文说 16000（一句话两个数）
 *   → 现在两边都必须是 16000，或者明确拒绝生成
 */
import {
  planConfirmSentence,
  buildConfirmSentence,
  deriveSpoken,
  checkSentenceAgainstFacts,
  factsForConfirm,
  valueNumbers,
  weekdaysIn,
} from '../dist/shared/facts.js';

let total = 0;
let failed = 0;

function eq(actual, expected, label) {
  total += 1;
  if (actual === expected) return;
  failed += 1;
  console.log(`  FAIL ${label}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`);
}

function ok(value, label) {
  total += 1;
  if (value) return;
  failed += 1;
  console.log(`  FAIL ${label}`);
}

function has(text, needle, label) {
  ok(String(text).includes(needle), `${label}（找不到「${needle}」：${text}）`);
}

function lacks(text, needle, label) {
  ok(!String(text).includes(needle), `${label}（不该出现「${needle}」：${text}）`);
}

// 一个「原话 15,000 dollars，用户改成 16000 美元」的事实
const money = (value = '16000美元', extra = {}) => ({
  id: 'm1',
  kind: 'money',
  value,
  sourceText: '15,000 dollars',
  edited: value !== '15000美元',
  originalValue: '15000美元',
  ...extra,
});

console.log('== A. 改值后句子与释义必须同源 ==');
{
  const plan = planConfirmSentence([money()], 'English', 'Chinese');
  eq(plan.ok, true, 'A1 能生成');
  has(plan.sentence, '16,000', 'A2 英文句子用改后的值');
  lacks(plan.sentence, '15,000', 'A3 英文句子不许留旧值');
  has(plan.meaning, '16000', 'A4 释义也用改后的值');
  lacks(plan.meaning, '15000', 'A5 释义不许留旧值');
  eq(valueNumbers(plan.sentence).join(','), '16000', 'A6 句子里只有一个金额且是新的');

  // 旧实现的实际输出（英文 15,000 + 中文 16000）必须被彻底堵死
  const both = `${plan.sentence}${plan.meaning}`;
  ok(
    valueNumbers(plan.sentence).every((n) => valueNumbers(plan.meaning).includes(n)),
    'A7 句子里的每个数都能在释义里找到（不再一词两数）',
  );
  ok(!both.includes('15,000 dollars'), 'A8 不再出现「旧英文 + 新中文」');
}

console.log('== B. 原话不被改写 ==');
{
  const fact = money();
  eq(fact.sourceText, '15,000 dollars', 'B1 原话作为证据原样保留');
  const plan = planConfirmSentence([fact], 'English', 'Chinese');
  has(factsForConfirm([fact]), '15,000 dollars', 'B2 给模型的输入里带着原话');
  has(factsForConfirm([fact]), '15000美元', 'B3 给模型的输入里带着改前值');
  has(factsForConfirm([fact]), '16000美元', 'B4 给模型的输入里带着改后值');
  eq(plan.ok, true, 'B5 两套值同时存在也能出句子');
}

console.log('== C. 日期 ==');
{
  const thursday = {
    id: 'd1',
    kind: 'date',
    value: '周五',
    sourceText: 'Thursday',
    edited: true,
    originalValue: '周四',
    certainty: 'corrected',
  };
  const tuesday = {
    id: 'd2',
    kind: 'date',
    value: '周二',
    sourceText: 'Tuesday',
    negated: true,
    certainty: 'corrected',
  };
  const plan = planConfirmSentence([thursday, tuesday], 'English', 'Chinese');
  eq(plan.ok, true, 'C1 能生成');
  has(plan.sentence, 'Friday', 'C2 用改后的周五');
  lacks(plan.sentence, 'Thursday', 'C3 不留周四');
  lacks(plan.sentence, 'Tuesday', 'C4 被否定的周二根本不进句子');
  has(plan.meaning, '周五', 'C5 释义是周五');
  lacks(plan.meaning, '周二', 'C6 释义里也没有被否定的周二');

  // 只勾被否定的旧值 → 不生成
  const onlyOld = planConfirmSentence([tuesday], 'English', 'Chinese');
  eq(onlyOld.ok, false, 'C7 只选旧值时不生成句子');
  eq(buildConfirmSentence([tuesday], 'English', 'Chinese'), null, 'C8 兼容函数同样返回 null');

  // 相对时间不擅自换算
  const relative = planConfirmSentence(
    [{ id: 'd3', kind: 'date', value: '明天', sourceText: 'tomorrow' }],
    'English',
    'Chinese',
  );
  has(relative.meaning, '明天', 'C9 相对时间保持「明天」');
  lacks(relative.meaning, '月', 'C10 不换算成具体日期');
  has(relative.sentence, 'tomorrow', 'C11 句子仍是原话 tomorrow');
}

console.log('== D. 时间点 ==');
{
  const plan = planConfirmSentence(
    [{ id: 't1', kind: 'time', value: '11:30', sourceText: '10:30 a.m.', edited: true, originalValue: '10:30' }],
    'English',
    'Chinese',
  );
  eq(plan.ok, true, 'D1 能生成');
  has(plan.sentence, '11:30', 'D2 用改后的时间');
  lacks(plan.sentence, '10:30', 'D3 不留旧时间');
  has(plan.meaning, '11:30', 'D4 释义同步');

  // 上午 / 下午 切换：3 p.m. → 10 a.m.
  const ampm = planConfirmSentence(
    [{ id: 't2', kind: 'time', value: '上午10点', sourceText: '3 p.m.', edited: true, originalValue: '下午3点' }],
    'English',
    'Chinese',
  );
  eq(ampm.ok, true, 'D5 时段切换能生成');
  has(ampm.sentence, '10 a.m.', 'D6 小时和上下午一起改');
  lacks(ampm.sentence, '3 p.m.', 'D7 不留旧的 3 p.m.');
}

console.log('== E. 推不出来就明确拒绝 ==');
{
  const currency = planConfirmSentence([money('15000日元')], 'English', 'Chinese');
  eq(currency.ok, false, 'E1 换币种不硬翻');
  eq(currency.blocked[0]?.reason, 'currency', 'E2 原因写明是币种/单位');
  eq(currency.sentence, '', 'E3 不给出半截句子');
  has(currency.message, '改说法', 'E4 告诉用户下一步点哪里');
  lacks(currency.message, 'Just to confirm', 'E5 错误文案里没有半截确认句');
  has(currency.message, '原话', 'E5b 用原话解释为什么推不出来');

  const place = planConfirmSentence(
    [{ id: 'p1', kind: 'place', value: '东门', sourceText: 'north gate', edited: true, originalValue: '北门' }],
    'English',
    'Chinese',
  );
  eq(place.ok, false, 'E6 换地点不硬翻');
  eq(place.blocked[0]?.reason, 'derive', 'E7 原因是推不出说法');
}

console.log('== F. 用户自己补的说法 ==');
{
  const plan = planConfirmSentence(
    [
      {
        id: 'm2',
        kind: 'money',
        value: '16000日元',
        sourceText: '15,000 dollars',
        edited: true,
        originalValue: '15000美元',
        spoken: '16,000 yen',
      },
    ],
    'English',
    'Chinese',
  );
  eq(plan.ok, true, 'F1 补了说法就能生成');
  has(plan.sentence, '16,000 yen', 'F2 用用户写的说法');
  has(plan.meaning, '16000日元', 'F3 释义仍是当前理解');

  const stale = planConfirmSentence(
    [
      {
        id: 'm3',
        kind: 'money',
        value: '16000美元',
        sourceText: '15,000 dollars',
        edited: true,
        originalValue: '15000美元',
        spoken: '15,000 dollars',
      },
    ],
    'English',
    'Chinese',
  );
  eq(stale.ok, false, 'F4 补的说法里是旧值时拒绝');
  eq(stale.blocked[0]?.reason, 'number', 'F5 原因是数值对不上');
}

console.log('== G. 模型输出的第二道闸 ==');
{
  const facts = [money()];
  const good = checkSentenceAgainstFacts(
    'Just to confirm, 16,000 dollars. Is that right?',
    '我理解的是16000美元，对吗？',
    facts,
  );
  eq(good.ok, true, 'G1 正确的句子放行');

  const oldNumber = checkSentenceAgainstFacts(
    'Just to confirm, 15,000 dollars. Is that right?',
    '我理解的是16000美元，对吗？',
    facts,
  );
  eq(oldNumber.ok, false, 'G2 抄回旧值被拦');
  has(oldNumber.message, '16000', 'G3 提示里说清缺了哪个新值');

  const missing = checkSentenceAgainstFacts(
    'Just to confirm. Is that right?',
    '我理解的是16000美元，对吗？',
    facts,
  );
  eq(missing.ok, false, 'G4 漏掉新值被拦');

  const staleDay = checkSentenceAgainstFacts(
    'Just to confirm, Thursday at 16,000 dollars. Is that right?',
    '我理解的是16000美元，对吗？',
    [
      { value: '周五', sourceText: 'Thursday', edited: true, originalValue: '周四' },
      { value: '16000美元', sourceText: '15,000 dollars', edited: true, originalValue: '15000美元' },
    ],
  );
  eq(staleDay.ok, false, 'G5 句子还念着旧的星期四被拦');

  const meaningStale = checkSentenceAgainstFacts(
    'Just to confirm, 16,000 dollars. Is that right?',
    '我理解的是15000美元，对吗？',
    facts,
  );
  eq(meaningStale.ok, false, 'G6 释义里是旧值一样被拦');
}

console.log('== H. 释义语言跟着理解语言 ==');
{
  const fact = { id: 'e1', kind: 'money', value: '15000美元', sourceText: '15,000 dollars' };
  const cn = planConfirmSentence([fact], 'English', 'Chinese');
  has(cn.meaning, '我理解的是', 'H1 中文理解者看中文释义');

  const jp = planConfirmSentence([fact], 'English', 'Japanese');
  has(jp.meaning, '私の理解では', 'H2 日语理解者看日语释义');
  lacks(jp.meaning, '我理解的是', 'H3 不再固定中文');

  const en = planConfirmSentence([fact], 'Japanese', 'English');
  has(en.sentence, '確認ですが', 'H4 目标语言是日语时句子是日语');
  has(en.meaning, 'I understand it as', 'H5 英语理解者看英语释义');
}

console.log('== I. 数值与星期的归一化 ==');
{
  eq(valueNumbers('1.5万').join(','), '15000', 'I1 1.5万 = 15000');
  eq(valueNumbers('15,000').join(','), '15000', 'I2 15,000 = 15000');
  eq(valueNumbers('15000').join(','), '15000', 'I3 纯数字');
  eq(weekdaysIn('周四').join(','), '3', 'I4 周四 = 3');
  eq(weekdaysIn('Thursday').join(','), '3', 'I5 Thursday = 3');
  eq(weekdaysIn('木曜日').join(','), '3', 'I6 木曜日 = 3');

  const wan = planConfirmSentence(
    [{ id: 'w1', kind: 'money', value: '1.6万', sourceText: '15,000 dollars', edited: true, originalValue: '1.5万' }],
    'English',
    'Chinese',
  );
  eq(wan.ok, true, 'I7 中文「万」写法也能对上');
  has(wan.sentence, '16,000', 'I8 换算后写 16,000');
}

console.log('== J. 多事实合并与去重 ==');
{
  const plan = planConfirmSentence(
    [
      { id: 'a', kind: 'date', value: '周四', sourceText: 'Thursday', certainty: 'corrected' },
      { id: 'b', kind: 'time', value: '10:30', sourceText: '10:30 a.m.' },
      { id: 'c', kind: 'money', value: '15000美元', sourceText: '15,000 dollars' },
    ],
    'English',
    'Chinese',
  );
  eq(plan.ok, true, 'J1 三条能合成一句');
  has(plan.sentence, 'Thursday', 'J2 含星期');
  has(plan.sentence, '10:30', 'J3 含时间');
  has(plan.sentence, '15,000', 'J4 含金额');
  eq((plan.sentence.match(/\.\s/g) ?? []).length <= 2, true, 'J5 句号没有叠成一串');
  ok(!plan.sentence.includes('..'), 'J6 不出现连续两个句号');

  // 同一个值在原话里出现两次，句子里只念一次
  const dup = planConfirmSentence(
    [
      { id: 'x', kind: 'money', value: '15000美元', sourceText: '15,000 dollars' },
      { id: 'y', kind: 'money', value: '15000美元', sourceText: '15,000 dollars' },
    ],
    'English',
    'Chinese',
  );
  eq((dup.sentence.match(/15,000/g) ?? []).length, 1, 'J7 重复值只念一次');
}

console.log('== K. 输入不完整时的行为 ==');
{
  eq(planConfirmSentence([], 'English', 'Chinese').ok, false, 'K1 没选事实不生成');
  eq(planConfirmSentence([], 'English', 'Chinese').sentence, '', 'K2 不返回半截句子');
  const blank = planConfirmSentence(
    [{ id: 'z', kind: 'task', value: '   ', sourceText: 'send it' }],
    'English',
    'Chinese',
  );
  eq(blank.ok, false, 'K3 空值不当事实');
}

console.log('== L. deriveSpoken 的边界 ==');
{
  const untouched = deriveSpoken({ value: '周四', sourceText: 'Thursday' }, 'English');
  eq(untouched.ok, true, 'L1 没改过能取到说法');
  eq(untouched.changed, false, 'L2 标成「没改」');
  eq(untouched.text, 'Thursday', 'L3 就是原话');

  const edited = deriveSpoken(
    { value: '16000美元', sourceText: '15,000 dollars', edited: true, originalValue: '15000美元' },
    'English',
  );
  eq(edited.changed, true, 'L4 改过标成 changed');
  eq(edited.text, '16,000 dollars', 'L5 保留千分位写法');
}

console.log(failed === 0 ? `\nRESULT PASS ${total}/${total}` : `\nRESULT FAIL ${failed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
