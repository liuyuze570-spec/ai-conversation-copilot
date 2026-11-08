/**
 * 「新一批回复到了，要不要收掉用户打开的面板」的单元验证。
 *
 * 为什么单独测这条：它是时序相关的 —— 用户开着设置页改风格，十几秒后回复才回来，
 * 面板是否被抢走取决于那一刻的先后顺序。DOM 级的自检能不能复现全看运气（同一份
 * 代码，我前后两次运行一次全绿一次全红，就是差在这几百毫秒），所以规则本身必须
 * 由纯函数单测钉住，自检只负责验证「接线没接错」。
 *
 * import dist/ 里的产物 = 验证的就是真正会跑在用户机器上的那份代码。
 *
 * 用法：node .dev/reply-reveal-unit.mjs
 */

import { panelsAfterReplies } from '../dist/shared/reply-reveal.js';

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
  check(
    label,
    Object.is(actual, expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

/** 面板状态是对象，Object.is 比的是引用，必须逐字段比。 */
function eqPanels(label, actual, expected) {
  check(
    label,
    actual.showSettings === expected.showSettings && actual.showRecords === expected.showRecords,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

const closed = { showSettings: false, showRecords: false };
const settingsOpen = { showSettings: true, showRecords: false };
const recordsOpen = { showSettings: false, showRecords: true };
const bothOpen = { showSettings: true, showRecords: true };

// --------------------------------------------------------------------------- //
// 1. 用户主动要的回复：要把面板亮出来（原有行为，不能改坏）
// --------------------------------------------------------------------------- //

eqPanels('主动要的回复收掉设置面板', panelsAfterReplies(settingsOpen, 3, true), closed);
eqPanels('主动要的回复收掉记录面板', panelsAfterReplies(recordsOpen, 3, true), closed);
eqPanels('主动要的回复收掉两个面板', panelsAfterReplies(bothOpen, 3, true), closed);
eqPanels('本来就是关的，保持不变', panelsAfterReplies(closed, 3, true), closed);
eqPanels('不传 reveal 时默认按「主动要的」处理', panelsAfterReplies(settingsOpen, 3), closed);

// --------------------------------------------------------------------------- //
// 2. 自动来的回复（静默看门狗 / 改了风格后的重出）：不许抢面板
//    ↓ 这一组就是那个真实缺陷的回归断言
// --------------------------------------------------------------------------- //

eqPanels('自动来的回复不许收掉设置面板', panelsAfterReplies(settingsOpen, 3, false), settingsOpen);
eqPanels('自动来的回复不许收掉记录面板', panelsAfterReplies(recordsOpen, 3, false), recordsOpen);
eqPanels('自动来的回复不许收掉两个面板', panelsAfterReplies(bothOpen, 3, false), bothOpen);
eqPanels('自动来的回复、面板本来就关着，保持关着', panelsAfterReplies(closed, 3, false), closed);
// 关键不变量：自动路径下，面板状态必须逐字节等于调用前的状态。
{
  let untouched = true;
  for (const state of [closed, settingsOpen, recordsOpen, bothOpen]) {
    for (const count of [0, 1, 3, 99]) {
      const next = panelsAfterReplies(state, count, false);
      if (next.showSettings !== state.showSettings || next.showRecords !== state.showRecords) {
        untouched = false;
      }
    }
  }
  check('自动路径永不改动面板状态（不变量）', untouched);
}

// --------------------------------------------------------------------------- //
// 3. 清空回复：任何路径下都不该改动面板
// --------------------------------------------------------------------------- //

eqPanels('清空时不动设置面板（主动路径）', panelsAfterReplies(settingsOpen, 0, true), settingsOpen);
eqPanels('清空时不动设置面板（自动路径）', panelsAfterReplies(settingsOpen, 0, false), settingsOpen);
eqPanels('清空时不动记录面板', panelsAfterReplies(recordsOpen, 0, true), recordsOpen);
{
  let untouched = true;
  for (const state of [closed, settingsOpen, recordsOpen, bothOpen]) {
    for (const reveal of [true, false]) {
      const next = panelsAfterReplies(state, 0, reveal);
      if (next.showSettings !== state.showSettings || next.showRecords !== state.showRecords) {
        untouched = false;
      }
    }
  }
  check('清空回复永不改动面板状态（不变量）', untouched);
}

// --------------------------------------------------------------------------- //
// 4. 不能就地改掉调用方传进来的对象（store 会把它和 state 混在一起）
// --------------------------------------------------------------------------- //

{
  const input = { showSettings: true, showRecords: true };
  panelsAfterReplies(input, 3, true);
  check('不就地修改入参', input.showSettings === true && input.showRecords === true);
  const auto = panelsAfterReplies(input, 3, false);
  check('自动路径返回的是原对象或等值对象', auto.showSettings === true && auto.showRecords === true);
}

// --------------------------------------------------------------------------- //

if (failures.length) {
  console.log(`FAIL  ${passed} 通过，${failures.length} 失败`);
  for (const item of failures) console.log(`  × ${item}`);
  process.exit(1);
}
console.log(`PASS  ${passed}/${passed} 全部通过`);
