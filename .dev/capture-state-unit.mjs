// capture-state 状态机与采集会话闸门的纯函数单测。
// 这些函数不依赖 Electron / React / 麦克风，直接测 dist/shared/capture-state.js。
// 注意：unit 测试跑在 dist 编译产物上，需先 `npm run build:main`。

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const cs = require('../dist/shared/capture-state.js');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.error(`  ✗ ${msg}`);
  }
}
function eq(a, b, msg) {
  ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，得到 ${JSON.stringify(a)}）`);
}

// ---- 状态判据：no-audio 必须算「采集中」----
eq(cs.isCaptureActive('listening'), true, 'listening 是采集中');
eq(cs.isCaptureActive('starting'), true, 'starting 是采集中（等待授权）');
eq(cs.isCaptureActive('no-audio'), true, 'no-audio 是采集中（这是 0.6.2 的核心 bug：漏了它会点暂停变重启）');
eq(cs.isCaptureActive('paused'), false, 'paused 不是采集中');
eq(cs.isCaptureActive('idle'), false, 'idle 不是采集中');
eq(cs.isCaptureActive('error'), false, 'error 不是采集中');

// ---- 动作：只有 start / stop ----
eq(cs.captureAction('no-audio'), 'stop', 'no-audio 时动作必须是 stop（点下去真的停）');
eq(cs.captureAction('listening'), 'stop', 'listening 时动作 stop');
eq(cs.captureAction('starting'), 'stop', 'starting 时动作 stop（取消启动）');
eq(cs.captureAction('paused'), 'start', 'paused 时动作 start');
eq(cs.captureAction('idle'), 'start', 'idle 时动作 start');

// ---- 按钮文字：明确「开始采集 / 停止采集」----
eq(cs.captureButtonLabel('no-audio'), '停止采集', 'no-audio 按钮写停止采集');
eq(cs.captureButtonLabel('idle'), '开始采集', 'idle 按钮写开始采集');

// ---- 七个用户可感知阶段 ----
eq(cs.capturePhase('idle'), 'not-started', 'idle → 未开始');
eq(cs.capturePhase('starting'), 'awaiting-permission', 'starting → 等待授权');
eq(cs.capturePhase('listening', false), 'capturing', 'listening 空闲 → 采集中');
eq(cs.capturePhase('listening', true), 'processing', 'listening 忙碌 → 处理中');
eq(cs.capturePhase('no-audio'), 'no-signal', 'no-audio → 暂未收到声音');
eq(cs.capturePhase('paused'), 'stopped', 'paused → 已停止');
eq(cs.capturePhase('error'), 'failed', 'error → 失败');

// ---- 会话闸门 ----
const g0 = cs.initialCaptureGate();
eq(g0.active, true, '初始闸门开着（演示样例不受影响）');

const opened = cs.openCaptureGate(g0);
eq(opened.active, true, '开始采集 → 开闸');
ok(opened.epoch > g0.epoch, '开始采集 → epoch 推进');

// 收到 sessionId=3 的字幕后停止
const closed = cs.closeCaptureGate(opened, 3);
eq(closed.active, false, '停止 → 关闸');
eq(closed.floorSession, 4, '停止 → 门槛钉到 4（3+1）');

eq(cs.acceptsTranscript(closed, 5, 1000), false, '关闸后任何字幕都拒绝');
eq(cs.acceptsTranscript(opened, 3, 1000), true, '开闸时 >= 门槛的字幕接受');
// opened 是 openCaptureGate(g0)，g0.floorSession=0，open 不抬门槛，
// 所以 sessionId=2 仍应接受；真正抬门槛的是 closeCaptureGate / gateAfterSessionReset。
eq(cs.acceptsTranscript(opened, 2, 1000), true, 'openCaptureGate 不抬门槛，2 仍接受');

// 切会话的丢弃窗口
const reset = cs.gateAfterSessionReset(opened, 5, 1000);
eq(reset.active, true, '切会话不关采集闸门');
eq(reset.floorSession, 6, '切会话 → 门槛抬到 6（5+1）');
eq(cs.acceptsTranscript(reset, 6, 1100), false, '切会话后 250ms 内的排队包拒绝');
eq(cs.acceptsTranscript(reset, 6, 1300), true, '切会话 300ms 后新字幕接受');
eq(cs.acceptsTranscript(reset, 5, 1300), false, '切会话后低于门槛的旧会话号仍拒绝');

// 迟到启动回执
const e = opened.epoch;
eq(cs.isCurrentCaptureEpoch(opened, e), true, '当前代次回执接受');
eq(cs.isCurrentCaptureEpoch(opened, e - 1), false, '旧代次回执拒绝');

// ---- 切会话后「引擎重连」使 sessionId 同步 +1，新字幕继续进来 ----
// 修复背景：渲染层 gateAfterSessionReset 把 floorSession 抬到 lastSeenSession+1，
// 但音频引擎持续运行时 sessionId 不变，旧 sessionId 字幕会被永久挡住。
// 修复做法是切会话时若采集运行就触发 audioReconnect()（引擎 stop→sessionSeq+1→start），
// 使引擎 sessionId 与 floorSession 同步前进。下面钉住这个语义：
// 引擎重连后发出的新字幕 sessionId === floorSession，必须被接受。
const afterReconnectFloor = 6;
eq(cs.acceptsTranscript(reset, afterReconnectFloor, 1300), true,
  '切会话后引擎重连（sessionId 同步到 6），新字幕 sessionId=6 必须接受，不能永久被拒');
eq(cs.acceptsTranscript(reset, 5, 1300), false,
  '重连前仍在队列里的旧字幕 sessionId=5 仍被拒绝，不混进新会话');

console.log(`capture-state: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
