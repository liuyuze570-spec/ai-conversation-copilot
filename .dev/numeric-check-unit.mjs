/**
 * 关键信息一致性检查回归。
 *
 * 这些用例的来源不是编的：
 *  - A1 是 2026-11-08 审查报告里实测到的真实错误（本地 Opus-MT 把
 *    `twenty thousand` 译成 `2 000`，还多出原文没有的「提前」）；
 *  - A2/A3/A4 是比赛要求的三组案例的真实模型译文；
 *  - B 组是确认句中文读法，界面上要看得到、读得出来。
 *
 * 这个测试守的是「数字被译错要能被发现」这条线，不是「译文通顺」。
 * 所以断言关心的是 level / missing / unsourced，不是整句文本。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkNumericConsistency,
  toChineseSpeech,
  numberToChineseSpeech,
  negatedValues,
  scanNumbers,
  scanTimes,
} = require('../dist/shared/numeric-check.js');

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    return;
  }
  failures.push(`${name}\n    期望 ${e}\n    实际 ${a}`);
}

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    return;
  }
  failures.push(`${name}${detail ? `\n    ${detail}` : ''}`);
}

const vals = (hits) => hits.map((h) => h.value).sort((x, y) => x - y);

/* ------------------------------------------------------------------ */
/* A. 一致性检查：真错必须抓出来，对的不能误报                           */
/* ------------------------------------------------------------------ */

// A1 审查报告的真实错误：twenty thousand(20000) 被译成 2 000(2000)
{
  const r = checkNumericConsistency(
    'Please move the meeting to Friday at 2 p.m. The budget is twelve thousand, not twenty thousand.',
    '请将会议提前至星期五下午2时举行。 预算为12 000,而不是2 000。',
  );
  check('A1 级别', r.level, 'warn');
  check('A1 原文数值', vals(r.numbers.source), [12000, 20000]);
  check('A1 译文数值', vals(r.numbers.target), [2000, 12000]);
  check('A1 译文无来源的数', vals(r.numbers.unsourced), [2000]);
  check('A1 译文缺失的数', vals(r.numbers.missing), [20000]);
  ok('A1 提示里点出 2 000', r.message.includes('2 000'), r.message);
  ok('A1 提示里给出原文 20000', r.message.includes('20000'), r.message);
  // 时间与星期应当是对齐的，不该跟着报错
  check('A1 时间一致', r.times.unsourced.length + r.times.missing.length, 0);
  check('A1 星期一致', r.days.unsourced.length + r.days.missing.length, 0);
}

// A2 第三组案例：译文正确时不能误报
{
  const r = checkNumericConsistency(
    'The budget is fifteen thousand, not fifty thousand.',
    '预算是一万五千,不是五万。',
  );
  check('A2 级别', r.level, 'ok');
  check('A2 原文数值', vals(r.numbers.source), [15000, 50000]);
  check('A2 译文数值', vals(r.numbers.target), [15000, 50000]);
  check('A2 否定值', r.negation.source, [50000]);
  check('A2 译文否定值', r.negation.target, [50000]);
}

// A3 第一组案例：时间点对齐（3 p.m. ↔ 下午3时）
{
  const r = checkNumericConsistency('Please send the report by 3 p.m. tomorrow.', '请在明天下午3时前将报告发送。');
  check('A3 级别', r.level, 'ok');
  check('A3 原文时间', r.times.source.map((t) => `${t.hour}:${t.minute}`), ['15:0']);
  check('A3 译文时间', r.times.target.map((t) => `${t.hour}:${t.minute}`), ['15:0']);
}

// A4 第二组案例：否定 + 改期，两个星期都要在
{
  const r = checkNumericConsistency(
    'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
    '会议不在星期二举行,现已改为星期四上午10时30分举行。',
  );
  check('A4 级别', r.level, 'ok');
  check('A4 原文星期', r.days.source.map((d) => d.day).sort(), [1, 3]);
  check('A4 译文星期', r.days.target.map((d) => d.day).sort(), [1, 3]);
  check('A4 时间', r.times.target.map((t) => `${t.hour}:${t.minute}`), ['10:30']);
}

// A5 译文漏掉时间 → 必须报
{
  const r = checkNumericConsistency('Please send the report by 3 p.m. tomorrow.', '请在明天前把报告发出去。');
  check('A5 级别', r.level, 'warn');
  check('A5 缺失时间', r.times.missing.map((t) => t.hour), [15]);
}

// A6 译文把周四写成周三 → 必须报
{
  const r = checkNumericConsistency('It has moved to Thursday.', '已改到星期三。');
  check('A6 级别', r.level, 'warn');
  check('A6 无来源的星期', r.days.unsourced.map((d) => d.day), [2]);
  check('A6 缺失的星期', r.days.missing.map((d) => d.day), [3]);
}

// A7 `12 000` 与 `2 000` 的否定关系不能被前一个数带歪
//    （旧实现用 indexOf 定位，`2 000` 命中 `12 000` 的尾部，把「而不是」算到 12 000 头上）
{
  const neg = negatedValues('预算为12 000,而不是2 000。');
  check('A7 被否定的值', neg, [2000]);
}

// A9 方向被凭空加出来（审查报告点名：move 被译成「提前」）
{
  const r = checkNumericConsistency('Please move the meeting to Friday at 2 p.m.', '请将会议提前至星期五下午2时举行。');
  check('A9 级别', r.level, 'warn');
  check('A9 多出的方向', r.direction.targetExtra, ['earlier']);
  ok('A9 提示里点出提前', r.message.includes('提前'), r.message);
}

// A10 原文明确说 postpone，译文「推迟」是对的，不能误报
{
  const r = checkNumericConsistency('Please push the meeting back to 4 p.m.', '请把会议推迟到下午4点。');
  check('A10 级别', r.level, 'ok');
  check('A10 原文方向', r.direction.source, ['later']);
  check('A10 无多余方向', r.direction.targetExtra, []);
}

// A11 原文没说方向、译文也没说 → 不报
{
  const r = checkNumericConsistency('Please move the meeting to Friday at 2 p.m.', '请把会议改到周五下午2点。');
  check('A11 级别', r.level, 'ok');
}

// A8 空输入不炸、不误报
{
  const r = checkNumericConsistency('', '');
  check('A8 级别', r.level, 'ok');
  check('A8 提示', r.message, '');
}

/* ------------------------------------------------------------------ */
/* B. 中文读法：确认句要能直接念出来                                     */
/* ------------------------------------------------------------------ */

check('B1 下午四点', toChineseSpeech('4 p.m.'), '下午4点');
check('B2 下午两点', toChineseSpeech('2 p.m.'), '下午2点');
check('B3 上午十点半', toChineseSpeech('10:30 a.m.'), '上午10点30分');
check('B4 点号写法', toChineseSpeech('4.15pm'), '下午4点15分');
check('B5 星期五', toChineseSpeech('Friday'), '周五');
check('B6 明天', toChineseSpeech('tomorrow'), '明天');
check('B7 一万二千', toChineseSpeech('twelve thousand'), '一万二千');
check('B8 阿拉伯千分位', toChineseSpeech('15,000'), '一万五千');
check('B9 中文数字', numberToChineseSpeech(15000), '一万五千');
check('B10 二万', numberToChineseSpeech(20000), '二万');
check('B11 十二万', numberToChineseSpeech(123456), '十二万三千四百五十六');
check('B12 跨组补零', numberToChineseSpeech(100500), '十万零五百');
check('B13 百万', numberToChineseSpeech(1000000), '一百万');
check('B14 小于一万', numberToChineseSpeech(999), '九百九十九');

/* ------------------------------------------------------------------ */
/* C. 扫描器边界                                                        */
/* ------------------------------------------------------------------ */

// C1 「星期」里的「一」不能被当成数字
check('C1 星期一不算数', scanNumbers('星期一开会').map((h) => h.value), []);
// C2 「一万五千」按一个数读
check('C2 一万五千', scanNumbers('一万五千').map((h) => h.value), [15000]);
// C3 「1万5千」混写
check('C3 混写', scanNumbers('1万5千').map((h) => h.value), [15000]);
// C4 空格千分位与逗号千分位等价
check('C4 空格千分位', scanNumbers('12 000').map((h) => h.value), [12000]);
check('C5 逗号千分位', scanNumbers('12,000').map((h) => h.value), [12000]);
// C6 时间不该被当成普通数值
{
  const t = scanTimes('at 3 p.m.');
  check('C6 时间数', t.hits.map((h) => `${h.hour}:${h.minute}`), ['15:0']);
  check('C7 时间不进数值集', scanNumbers('at 3 p.m.', t.spans).map((h) => h.value), []);
}
// C8 带点与不带点的 am/pm 等价
check('C8 3pm', scanTimes('3pm').hits.map((h) => h.hour), [15]);
check('C9 3 p.m.', scanTimes('3 p.m.').hits.map((h) => h.hour), [15]);
// C10 下午 12 点不变成 24 点
check('C10 中午', scanTimes('12 p.m.').hits.map((h) => h.hour), [12]);
// C11 午夜 12 点归零
check('C11 午夜', scanTimes('12 a.m.').hits.map((h) => h.hour), [0]);

/* ------------------------------------------------------------------ */
/* C12–C18 单独数词（2026-11-09 补）：这些是假警报的来源                */
/* ------------------------------------------------------------------ */

check('C12 platform two', scanNumbers('platform two').map((h) => h.value), [2]);
check('C13 连字符', scanNumbers('forty-five').map((h) => h.value), [45]);
check('C14 十位+个位', scanNumbers('twenty five').map((h) => h.value), [25]);
// 不能把 `one hundred and fifty` 算成 100 和 150 两个数
check('C15 one hundred and fifty', scanNumbers('one hundred and fifty').map((h) => h.value), [150]);
check('C16 a hundred', scanNumbers('a hundred dollars').map((h) => h.value), [100]);
// one 当代词时不是数量
check('C17 no one', scanNumbers('no one is here').map((h) => h.value), []);
check('C18 one of them', scanNumbers('one of them').map((h) => h.value), []);

/* ------------------------------------------------------------------ */
/* A12–A15 由上面的盲区导致的误报/漏报                                   */
/* ------------------------------------------------------------------ */

// A12 原句有 platform two，译文写「2 号站台」——两边都是 2，不该报
{
  const r = checkNumericConsistency(
    'The train leaves at seven forty-five from platform two.',
    '列车从2号站台 7:45 离开。',
  );
  check('A12 不把 2 当成无来源', r.numbers.unsourced.map((h) => h.value), []);
}

// A13 拼写时间被写成 745：提示要指向 745，不要顺带报「7 / 45 没出现」
{
  const r = checkNumericConsistency(
    'The train leaves at seven forty-five from platform two.',
    '列车从2号站台起 745离开',
  );
  check('A13 级别', r.level, 'warn');
  check('A13 无来源的数', r.numbers.unsourced.map((h) => h.value), [745]);
  check('A13 缺失的数', r.numbers.missing.map((h) => h.value), []);
  ok('A13 提示指出 745', r.message.includes('745'), r.message);
  ok('A13 不把平台号 2 拉进提示', !/two = 2/.test(r.message), r.message);
}

// A14 原文说 three，译文说「两个人」——数量被改了，必须报
{
  const r = checkNumericConsistency('There are three people in the room.', '房间里有两个人。');
  check('A14 级别', r.level, 'warn');
  check('A14 缺失的数', r.numbers.missing.map((h) => h.value), [3]);
}

// A15 冠词数词：a hundred dollars ↔ 一百美元
{
  const r = checkNumericConsistency('It costs a hundred dollars.', '这个要一百美元。');
  check('A15 级别', r.level, 'ok');
}

// A16 中文读法：英文值转成中文口语，不能留 next / p.m. 这种尾巴
check('A16 next Monday', toChineseSpeech('next Monday'), '下周一');
check('A17 点分时间', toChineseSpeech('4.15 p.m.'), '下午4点15分');
check('A18 时间+星期', toChineseSpeech('Friday at 2 p.m.'), '周五下午2点');

/* ------------------------------------------------------------------ */

const total = pass + failures.length;
if (failures.length) {
  console.log(`\n一致性检查：失败 ${failures.length} 条 / 共 ${total} 条\n`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`一致性检查：通过 ${pass} 条，失败 0 条`);
