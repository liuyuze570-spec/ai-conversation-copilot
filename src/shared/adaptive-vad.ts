/**
 * 自适应切句门槛。
 *
 * 老实现是**固定绝对下限**：`startThreshold = max(200, noiseFloor * 2.4)`。
 * 200 在 int16 刻度上约等于 -44 dBFS —— 意思是「比这更轻的声音一律当静音」。
 * 素材本身就很轻的时候（小声的对白、纪录片的环境音、离麦很远的对话），整段
 * 直接被丢掉，一个字幕都切不出来，界面上还只显示「没有听到任何声音」，
 * 完全看不出真正的原因。
 *
 * 新规则只有一条：**门槛可以跟着「最近确实听到过的信号峰值」往下走，但永远
 * 不会高于原来的 200**。也就是说正常音量的行为一字不变；只有当我们已经证明
 * 「声音是有的，只是很轻」时，才把标尺放低。
 *
 * 抽成纯函数是为了能被单元测试直接验证 —— 本项目的真实音频链路在沙箱里经常
 * 起不来，规则本身对不对必须能用数字证明。
 */

/** 旧实现的固定下限。现在改当「上限」用：任何时候都不会比它更严。 */
export const LEGACY_CEILING = 200;

/**
 * 绝对保底（int16 刻度，约 -52 dBFS）。
 *
 * 防止「一片死寂」时门槛被拉到 0、把底噪当成说话。实践上它几乎不生效 ——
 * noiseFloor 的下限是 40，floorGuard 至少 96 —— 留着是为了让这条约束显式。
 */
export const ABSOLUTE_FLOOR = 80;

/** 近期峰值的每帧衰减系数（每帧 100ms）。约 3.4 秒衰减一半。 */
export const PEAK_DECAY = 0.98;

export interface VadThresholds {
  /** 起判门槛：静音 → 说话需要跨过它。 */
  start: number;
  /** 续判门槛：已经在说话时，掉到它以下才算停。比 start 低，避免切断句子。 */
  keep: number;
}

/**
 * 算出这一帧的起判 / 续判门槛。
 *
 * @param noiseFloor 学习到的环境底噪（int16 RMS）
 * @param recentPeak 最近听到过的最响一块（int16 RMS，带衰减）
 */
export function computeThresholds(noiseFloor: number, recentPeak: number): VadThresholds {
  // 相对底噪的下限：绝不比环境噪声本身更敏感。
  const floorGuard = Math.max(40, noiseFloor * 2.4);

  // 相对近期峰值的下限。recentPeak 为 0（一片安静）时它是 0，此时不起作用，
  // 门槛由 floorGuard / ABSOLUTE_FLOOR 兜住，不会误触发。
  const spanGuard = Math.max(0, recentPeak) * 0.3;

  const start = Math.max(floorGuard, ABSOLUTE_FLOOR, Math.min(LEGACY_CEILING, spanGuard));

  // 续判门槛必须明显低于起判门槛，否则说话中间的自然停顿会把一句话切成两半，
  // 两半各翻一次，读起来就「英文和中文对不上」。
  const keep = Math.max(60, noiseFloor * 1.5, start * 0.55);

  return { start, keep };
}

/** 推进「近期峰值」追踪器。每帧调用一次。 */
export function nextRecentPeak(current: number, rms: number): number {
  return Math.max(Math.max(0, rms), Math.max(0, current) * PEAK_DECAY);
}
