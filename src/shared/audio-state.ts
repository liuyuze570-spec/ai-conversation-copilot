import type { ListeningStatus } from './types';

/**
 * 音频链路的「用户看得见的状态」。
 *
 * 为什么要把状态从 `ListeningStatus` 再推一层：原来的 status 是**程序视角**
 * （idle / listening / no-audio …），直接印到界面上会糊成一片 ——
 * 「正在采集但暂时没声音」和「根本没启动采集」在界面上都像「没在听」，
 * 用户点了一次开始、看到没有字幕，就会一直点下去。
 *
 * 这一层把状态翻译成一句人话 + 一个明确的下一步动作，并且规定：
 * **只有真的启动成功才显示「正在采集」**（见 main/audio/audio-controller.ts
 * 的启动回执，那里等 sidecar 的 started 事件，不再默认成功）。
 */

/** 阶段：给颜色 / 图标 / 提示语用，粒度比 status 粗。 */
export type AudioPhase = 'stopped' | 'starting' | 'live' | 'silent' | 'paused' | 'failed';

export interface AudioUiState {
  phase: AudioPhase;
  /** 主状态（一句话，尽量短）。 */
  label: string;
  /** 补充说明：为什么是这样、下一步能做什么。 */
  detail: string;
  /** 语义色，**不是**唯一表达方式（旁边永远有文字）。 */
  tone: 'idle' | 'ok' | 'warn' | 'danger';
  /** 主按钮该做什么。 */
  action: 'start' | 'stop' | 'reconnect';
  /** 是否值得把「重新连接音频」摆在显眼位置。 */
  showReconnect: boolean;
  /** 读屏播报用的完整句子（比 label + detail 更适合朗读）。 */
  announcement: string;
}

/**
 * 把 status 翻成界面语言。
 *
 * `hasSignal` 决定「正在采集」要不要说成「听到了声音」：
 * 采集进程活着但最近 N 秒没信号，就要明确写「暂未收到声音」，
 * 不能让用户以为已经暂停了。
 */
export function audioUiState(
  status: ListeningStatus,
  options: { hasSignal: boolean; engineAlive: boolean; message?: string },
): AudioUiState {
  const { hasSignal, engineAlive, message } = options;

  switch (status) {
    case 'starting':
      return {
        phase: 'starting',
        label: '正在连接音频…',
        detail: message || '正在打开音频设备，通常 1～2 秒。如果一直停在这里，点「重新连接」。',
        tone: 'warn',
        action: 'stop',
        showReconnect: true,
        announcement: '正在连接音频，请稍候',
      };
    case 'listening':
      return hasSignal
        ? {
            phase: 'live',
            label: '正在采集',
            detail: message || '已经听到声音，字幕会陆续出现。',
            tone: 'ok',
            action: 'stop',
            showReconnect: false,
            announcement: '正在采集，已听到声音',
          }
        : {
            phase: 'silent',
            label: '采集中，暂未收到声音',
            detail:
              message ||
              '采集是开着的，只是最近几秒没有声音进来。播放对方的声音或让麦克风收到说话声即可。',
            tone: 'warn',
            action: 'stop',
            showReconnect: true,
            announcement: '正在采集，但暂时没有收到声音',
          };
    /*
     * `no-audio` 是 sidecar 自己报的「采了几秒但一句都没听到」。
     *
     * 它和 `listening` 是同一件事的两个说法：采集在跑，只是没声音。
     * 漏掉这一档（旧写法让它落进 default）会让状态条写着「正在连接音频…」，
     * 而下面那行 detail 却在说「已采集 5 秒，但没有听到任何声音」 ——
     * 同一个框里两句话互相矛盾，用户只会以为软件卡住了。
     */
    case 'no-audio':
      return {
        phase: 'silent',
        label: '采集中，暂未收到声音',
        detail:
          message ||
          '采集进程在跑，但还没有收到声音。确认对方在说话 / 视频在播放，或点「重新连接」换一路音源。',
        tone: 'warn',
        action: 'stop',
        showReconnect: true,
        announcement: '正在采集，但暂时没有收到声音',
      };
    case 'paused':
      return {
        phase: 'paused',
        label: '已暂停',
        detail: message || '采集已停止，不会再产生新字幕。点「开始」继续。',
        tone: 'idle',
        action: 'start',
        showReconnect: false,
        announcement: '已暂停采集',
      };
    case 'error':
      return {
        phase: 'failed',
        label: '音频采集失败',
        detail: message || '音频进程没有起来。点「重新连接」再试一次，不需要重启软件。',
        tone: 'danger',
        action: 'reconnect',
        showReconnect: true,
        announcement: '音频采集失败，可以点重新连接再试一次',
      };
    case 'idle':
    default:
      return engineAlive
        ? {
            phase: 'starting',
            label: '正在连接音频…',
            detail: message || '正在打开音频设备。',
            tone: 'warn',
            action: 'stop',
            showReconnect: true,
            announcement: '正在连接音频',
          }
        : {
            phase: 'stopped',
            label: '未开始采集',
            detail: message || '点「开始」采集电脑里对方的声音。',
            tone: 'idle',
            action: 'start',
            showReconnect: false,
            announcement: '尚未开始采集',
          };
  }
}

/** 最近一段时间的信号采样。只留时间戳和响度，不留音频。 */
export interface SignalSample {
  at: number;
  db: number;
}

/**
 * 「最近有没有声音」的窗口长度。
 *
 * 不用「全程最大音量」判断：一场两小时的会议里，只要开头响过一声，
 * 用最大值判断就会一直认为「有声音」，中途对方静音、设备被拔掉、
 * 或者切到了别的输出设备，界面都不会提示 —— 这正是要避免的。
 * 反过来窗口太短会被句间停顿误判成掉音，8 秒是这两者之间的折中。
 */
export const SIGNAL_WINDOW_MS = 8000;

/** 低于这个响度视为「没有说话」。int16 RMS 换算成 dBFS 后 -55 大致是安静房间。 */
export const SIGNAL_DB_FLOOR = -55;

/**
 * 记一次采样，并丢掉窗口外的旧样本。
 *
 * 纯函数（返回新数组），方便单测直接跑，也避免调用方复用数组时踩到引用问题。
 */
export function pushSignal(
  window: SignalSample[],
  sample: SignalSample,
  spanMs: number = SIGNAL_WINDOW_MS,
): SignalSample[] {
  const cutoff = sample.at - spanMs;
  const kept = window.filter((item) => item.at >= cutoff);
  kept.push(sample);
  return kept;
}

/** 窗口里有没有超过底噪的采样。空窗口算「没有」。 */
export function hasRecentSignal(
  window: SignalSample[],
  now: number,
  spanMs: number = SIGNAL_WINDOW_MS,
  floorDb: number = SIGNAL_DB_FLOOR,
): boolean {
  const cutoff = now - spanMs;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const item = window[i];
    if (item.at < cutoff) break;
    if (item.db > floorDb) return true;
  }
  return false;
}
