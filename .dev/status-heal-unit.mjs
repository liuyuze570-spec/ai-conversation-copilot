/**
 * 「多轮监听中断」两条规则的单元验证。
 *
 * 为什么要有这个测试：用户报的 bug 是「第一轮暂停之后，第二轮就再也听不到 /
 * 不自动回应」。根因是两条判断写得太紧，而它们**只在真实音频链路上才会暴露**
 * （需要 sidecar 先报一次 silent，再等声音回来）。开发机/沙箱里 sidecar 经常
 * 因为 spawn EBUSY 起不来，跑不了端到端 —— 所以把规则抽成纯函数，在这里钉死。
 *
 * 这里 import 的是**编译产物**（dist/），不是源码的复制品，所以断言的就是真正
 * 会跑在用户机器上的那份代码。
 *
 * 用法：node .dev/status-heal-unit.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sharedPath = path.join(root, 'dist', 'shared', 'audio-status.js');
const mainPath = path.join(root, 'dist', 'main', 'audio', 'status-heal.js');
for (const p of [sharedPath, mainPath]) {
  if (!existsSync(p)) {
    console.error(`缺少编译产物：${p}\n先跑 npm run build。`);
    process.exit(2);
  }
}

const { canWatchForPause } = require(sharedPath);
const { signalHealsStatus } = require(mainPath);

const results = [];
function check(label, actual, expected) {
  const ok = actual === expected;
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} got=${actual} want=${expected}`);
}

console.log('== 规则 1：renderer 看门狗的前置条件 canWatchForPause ==');
// 这是修复的核心：'no-audio' 也必须允许看门狗工作。
check("listening  -> 允许（本来就有）", canWatchForPause('listening'), true);
check("no-audio   -> 允许（本次修复；以前是 false，导致整场失效）", canWatchForPause('no-audio'), true);
check('paused     -> 不允许（用户自己关的监听）', canWatchForPause('paused'), false);
check('error      -> 不允许（采集坏了）', canWatchForPause('error'), false);
check('idle       -> 不允许（还没开始）', canWatchForPause('idle'), false);
check('offline    -> 不允许', canWatchForPause('offline'), false);

console.log('');
console.log('== 规则 2：主进程状态自愈 signalHealsStatus ==');
check('报过静音 + 正在说话      -> 自愈', signalHealsStatus(true, { speaking: true, db: -30 }), true);
check('报过静音 + 电平 -25dB     -> 自愈（说话标记可能滞后）', signalHealsStatus(true, { speaking: false, db: -25 }), true);
check('报过静音 + 电平 -80dB     -> 不自愈（确实还是安静的）', signalHealsStatus(true, { speaking: false, db: -80 }), false);
check('没报过静音 + 有声音       -> 不动（状态本来就是对的）', signalHealsStatus(false, { speaking: true, db: -20 }), false);
check('边界：恰好 -60dB         -> 不自愈（严格大于才修真）', signalHealsStatus(true, { speaking: false, db: -60 }), false);

const passed = results.filter(Boolean).length;
console.log('');
console.log(`RESULT: ${results.every(Boolean) ? 'PASS' : 'FAIL'}  (${passed}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 1);
