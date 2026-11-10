import type { ListeningStatus } from './types';

/**
 * 采集状态的**唯一判据**（0.6.3）。
 *
 * 0.6.2 里 SourceBar、TitleBar、useCopilot.toggleListening 各自写了
 * `status === 'listening' || status === 'starting'`，三份清单还不一样：
 *  - SourceBar 把 `no-audio` 算作 running，按钮显示「暂停」；
 *  - toggleListening 不认 `no-audio`，点「暂停」实际调的是 startListening；
 *  - TitleBar 也不认 `no-audio`，同一个时刻显示「开始采集」。
 * 结果就是：采集中但暂时没声音时，界面说「暂停」，点下去反而重新开始采集，
 * 用户以为已经停了。这一层把所有判断收敛成一个函数，UI 与快捷键都必须用它。
 *
 * 语义：`starting` / `listening` / `no-audio` 都表示**采集链路活着**。
 * `no-audio` 不是「停了」，只是这几秒没有声音进来。
 */
export function isCaptureActive(status: ListeningStatus): boolean {
  return status === 'starting' || status === 'listening' || status === 'no-audio';
}

/** 明确的主按钮动作：只有两种，不再有「暂停」这种含混说法。 */
export type CaptureAction = 'start' | 'stop';

export function captureAction(status: ListeningStatus): CaptureAction {
  return isCaptureActive(status) ? 'stop' : 'start';
}

/** 按钮文字。用户要求「提供明确、易发现的开始采集和停止采集」。 */
export function captureButtonLabel(status: ListeningStatus): string {
  return captureAction(status) === 'stop' ? '停止采集' : '开始采集';
}

/** 按钮的可访问名称：读屏不靠颜色/图标，直接念出动作与当前状态。 */
export function captureButtonAria(status: ListeningStatus): string {
  const action = captureAction(status);
  return action === 'stop'
    ? `停止采集，当前状态：${captureStatusText(status)}。快捷键 Alt + P`
    : `开始采集，当前状态：${captureStatusText(status)}。快捷键 Alt + P`;
}

/**
 * 七个用户可感知的状态（比赛要求逐项区分）。
 *
 * 桌面端没有浏览器的「共享屏幕授权」弹窗，`starting` 在这里是等待音频
 * 设备就绪/系统授权；网页端对应的授权态在 tabAudio.ts 单独维护。
 * `processing`（处理中）不是 ListeningStatus 的一档，而是与采集并行的
 * 「正在翻译 / 正在生成回复」，由界面用 busy 叠加显示，见 SourceBar。
 */
export type CapturePhase =
  | 'not-started'
  | 'awaiting-permission'
  | 'capturing'
  | 'no-signal'
  | 'processing'
  | 'stopped'
  | 'failed';

export function capturePhase(status: ListeningStatus, busy = false): CapturePhase {
  if (status === 'error' || status === 'offline') return 'failed';
  if (status === 'paused') return 'stopped';
  if (status === 'starting') return 'awaiting-permission';
  if (status === 'no-audio') return 'no-signal';
  if (status === 'listening') return busy ? 'processing' : 'capturing';
  return 'not-started';
}

export const CAPTURE_PHASE_LABEL: Record<CapturePhase, string> = {
  'not-started': '未开始采集',
  'awaiting-permission': '等待音频设备授权…',
  capturing: '正在采集',
  'no-signal': '采集中，暂未收到声音',
  processing: '采集中 · 正在处理',
  stopped: '已停止采集',
  failed: '采集失败',
};

/** 标题栏一句话状态。每一档单独能读懂，不靠颜色区分。 */
export function captureStatusText(status: ListeningStatus): string {
  return CAPTURE_PHASE_LABEL[capturePhase(status)];
}

/** 读屏播报：一句完整的话，说明「现在怎样 + 下一步能做什么」。 */
export function captureAnnouncement(status: ListeningStatus, busy = false): string {
  const phase = capturePhase(status, busy);
  const label = CAPTURE_PHASE_LABEL[phase];
  switch (phase) {
    case 'awaiting-permission':
      return `${label}请稍候；如果一直停在这里，可以点重新连接。`;
    case 'no-signal':
      return `${label}。采集并没有停止，播放对方的声音或检查音源即可；要完全停止请点停止采集。`;
    case 'processing':
      return `${label}。采集仍在继续。`;
    case 'failed':
      return `${label}。可以点重新连接再试一次，不需要重启软件。`;
    case 'stopped':
      return `${label}，不会再产生新字幕。点开始采集继续。`;
    case 'capturing':
      return `${label}，字幕会陆续出现。点停止采集可完全停止并释放音频设备。`;
    default:
      return `${label}。请先确认音源，再点开始采集。`;
  }
}

/* ------------------------------------------------------------------ *
 * 会话闸门：保证「停止」之后，旧会话的字幕/回复一律不许回填。
 *
 * 主进程已经按 sessionId 和 engineGeneration 过滤过一次，但渲染层原来
 * 只挡 `payload.sessionId < lastSessionRef`，停止本身**不推进**这个门槛，
 * 也不拒绝「停止瞬间已经排在 IPC 队列里」的同号字幕。这里把闸门做成纯
 * 状态机：停止先同步关闸（不等 await audioStop 回来），开启时再开闸。
 * ------------------------------------------------------------------ */

export interface CaptureGate {
  /** 是否接受字幕事件。关闭时任何回包都丢弃。 */
  active: boolean;
  /** 每次开始 +1，用来识别迟到的启动回执。 */
  epoch: number;
  /** 低于这个会话号的字幕一律丢弃（停止时钉在当前最大号 +1）。 */
  floorSession: number;
  /**
   * 切会话后的短暂丢弃窗口（绝对时间戳，毫秒）。
   * 新建会话时主进程可能已经把上一场的字幕排进 IPC 队列，事件没有时间戳
   * 也没换 sessionId，只能靠一个很短的窗口把排队包挡掉；窗口过后新字幕
   * 正常进入。这不是「按内容判断」，仅用于堵住停止/切会话那一瞬的竞态。
   */
  discardUntilMs: number;
}

/** 切换会话后丢弃排队回包的窗口长度。够覆盖一次 IPC 往返，不会吃掉新字幕。 */
export const SESSION_RESET_DISCARD_MS = 250;

export function initialCaptureGate(): CaptureGate {
  return { active: true, epoch: 0, floorSession: 0, discardUntilMs: 0 };
}

/** 开始采集：开闸并推进代次，同时清掉切会话留下的丢弃窗口。 */
export function openCaptureGate(prev: CaptureGate): CaptureGate {
  return {
    active: true,
    epoch: prev.epoch + 1,
    floorSession: prev.floorSession,
    discardUntilMs: 0,
  };
}

/**
 * 停止采集：立刻关闸，并把门槛钉到「目前收到过的最大会话号 + 1」。
 * 之后即使主进程回了一个同 sessionId 的旧字幕，也不会被写进当前记录。
 */
export function closeCaptureGate(prev: CaptureGate, lastSeenSession = 0): CaptureGate {
  return {
    active: false,
    epoch: prev.epoch + 1,
    floorSession: Math.max(prev.floorSession, lastSeenSession + 1),
    discardUntilMs: 0,
  };
}

/**
 * 切换会话：保留采集状态（用户没点停止），只把已在队列里的旧回包挡掉一小段，
 * 并把最低接受会话号抬到当前最大号 +1，防止上一场的迟到识别写进新会话。
 */
export function gateAfterSessionReset(
  prev: CaptureGate,
  lastSeenSession = 0,
  now = Date.now(),
): CaptureGate {
  return {
    ...prev,
    epoch: prev.epoch + 1,
    floorSession: Math.max(prev.floorSession, lastSeenSession + 1),
    discardUntilMs: now + SESSION_RESET_DISCARD_MS,
  };
}

/**
 * 这条字幕能不能进界面？
 * - 闸门关着（已停止 / 未开始）→ 一律拒绝；
 * - 会话号低于门槛（上一场遗留）→ 拒绝；
 * - 切会话后的丢弃窗口内（排队包）→ 拒绝；
 * - 没带会话号（演示模式 / 旧事件）→ 只看闸门与窗口。
 */
export function acceptsTranscript(
  gate: CaptureGate,
  payloadSessionId?: number,
  now = Date.now(),
): boolean {
  if (!gate.active) return false;
  if (now < gate.discardUntilMs) return false;
  if (typeof payloadSessionId === 'number' && payloadSessionId < gate.floorSession) return false;
  return true;
}

/** 迟到的启动回执：代次对不上就不能把状态改回「正在采集」。 */
export function isCurrentCaptureEpoch(gate: CaptureGate, epoch: number): boolean {
  return gate.active && gate.epoch === epoch;
}

/**
 * 识别失败（超时 / 网络 / 额度不足）时，设备采集状态应该是什么？
 *
 * 识别失败 ≠ 采集停止：设备还在收声音，只是这一句没转写出来。这时候
 * 状态必须保持「采集中」——否则界面把按钮变成「开始采集」，用户一点就
 * 又开一路，旧的采集链路却没释放。识别失败这件事由字幕标记（onDropped）
 * 单独告知，不能污染设备状态。
 *
 * 返回 `listening`（而不是 `error`）：识别失败后设备依然活着，下一次成功
 * 识别就能接着出字幕，无需用户重新开始。
 */
export function sttFailureKeepsCapture(): 'listening' {
  return 'listening';
}
