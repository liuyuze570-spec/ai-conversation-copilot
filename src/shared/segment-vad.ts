/**
 * 切句状态机（纯函数）。
 *
 * 从 main/audio/python-engine 里抽出来，是因为原来内联的那版有一个**会一直
 * 泄漏内存**的 bug，而且极难在界面上看出来：
 *
 * 旧逻辑的收官条件是
 *     `enoughSpeech && (silenceMs >= vadSilenceMs || elapsedMs >= MAX_SEGMENT_MS)`
 * 两个条件被 `enoughSpeech`（语音块 ≥ 3）**同时**卡住。于是只要有一段
 * 100–200ms 的短噪声（点鼠标、椅子响、播放器的提示音）把 `speaking` 打开，
 * 之后人一直不说话，语音块就永远到不了 3 —— 而 `segment` 还在每个 100ms
 * 帧上无条件追加静音。结果是：
 *   · 这一段永远不收官，静音被无限录进缓冲区，内存一路涨；
 *   · 12 秒上限形同虚设（它和 enoughSpeech 是「与」的关系）；
 *   · 真有下一句时，这一句前面拖着几十秒静音，识别质量也被拖坏。
 *
 * 现在规则改成三条独立生效的闸门：
 *   1. 静音够久 → 语音块够了就收官，不够就**整段丢弃**（短噪声就该丢）；
 *   2. 时长到上限 → 同上，但**不再看静音**；
 *   3. 字节到硬上限 → 同上，兜住任何漏算的情况。
 * 时长用「块数 × 每块毫秒」算，而不是 `Date.now()` 差值：这才是音频真实长度，
 * 也不会因为主进程被别的活卡住而把 3 秒的片段算成 8 秒。
 */

export interface SegmentConfig {
  /** 每个块的毫秒数（当前是 100）。 */
  chunkMs: number;
  /** 少于这么多语音块就当噪声（当前是 3 = 300ms）。 */
  minSpeechChunks: number;
  /** 单段最长时长，超过就强制收官。 */
  maxSegmentMs: number;
  /** 单段最多占多少字节，最后一道保险。 */
  maxSegmentBytes: number;
  /** 判断「说完了」需要的静音长度。 */
  vadSilenceMs: number;
}

export interface SegmentState {
  /** 是否正在累积一段话。 */
  speaking: boolean;
  /** 这一段里「响」的块数。 */
  speechChunks: number;
  /** 这一段尾部连续静音的块数。 */
  silenceChunks: number;
  /**
   * 这一段累计的**总帧数**（含中途的短暂停顿）。
   *
   * 为什么单独存：`speechChunks + silenceChunks` 会漏算「说话 → 短停 → 又说话」
   * 里的那次短停 —— `silenceChunks` 在重新开口时被清零了。一段话里停顿几次，
   * 时长就被少算几帧；停得越多，标称 12 秒的上限触发得越晚，缓冲区也就越大。
   * 帧数只增不减，才是真实音频长度。
   */
  totalChunks: number;
  /** 已经累积的字节数。 */
  bytes: number;
}

export type SegmentAction = 'idle' | 'start' | 'append' | 'finish' | 'drop';

export const EMPTY_SEGMENT: SegmentState = {
  speaking: false,
  speechChunks: 0,
  silenceChunks: 0,
  totalChunks: 0,
  bytes: 0,
};

export interface ChunkInfo {
  /** 这一块的 RMS（int16 量级）。 */
  rms: number;
  /** 这一块占多少字节。 */
  bytes: number;
}

export interface Thresholds {
  /** 起判门槛（从静到说）。 */
  start: number;
  /** 续判门槛（说着的时候维持），比 start 低，形成迟滞。 */
  keep: number;
}

export interface SegmentDecision {
  action: SegmentAction;
  next: SegmentState;
  /** 收官或丢弃的原因，用于日志。 */
  reason?: string;
}

/**
 * 决定这一帧该怎么处理。
 *
 * 调用方拿到 action 后要做的事：
 * - `start`   → 用这一帧开一个新缓冲区
 * - `append`  → 把这一帧追加进当前缓冲区
 * - `finish`  → 把当前缓冲区交给识别，然后清空
 * - `drop`    → 直接丢掉当前缓冲区（短噪声 / 超限），清空
 * - `idle`    → 丢掉这一帧（静音，顺便学习底噪）
 */
export function decideSegment(
  state: SegmentState,
  chunk: ChunkInfo,
  thresholds: Thresholds,
  config: SegmentConfig,
): SegmentDecision {
  const active = state.speaking ? chunk.rms > thresholds.keep : chunk.rms > thresholds.start;

  if (!state.speaking) {
    if (!active) return { action: 'idle', next: state };
    return {
      action: 'start',
      next: { speaking: true, speechChunks: 1, silenceChunks: 0, totalChunks: 1, bytes: chunk.bytes },
    };
  }

  const speechChunks = active ? state.speechChunks + 1 : state.speechChunks;
  const silenceChunks = active ? 0 : state.silenceChunks + 1;
  const totalChunks = state.totalChunks + 1;
  const bytes = state.bytes + chunk.bytes;
  const next: SegmentState = { speaking: true, speechChunks, silenceChunks, totalChunks, bytes };

  const enoughSpeech = speechChunks >= config.minSpeechChunks;
  const silenceMs = silenceChunks * config.chunkMs;
  // 用累计帧数算真实音频长度：不依赖墙钟，也不会漏掉中途的短暂停顿。
  const durationMs = totalChunks * config.chunkMs;

  // 闸门 1：静音够久（对方说了句短的 / 只是碰了一下键盘）。
  if (silenceMs >= config.vadSilenceMs) {
    if (enoughSpeech) return { action: 'finish', next: reset(), reason: 'silence' };
    return { action: 'drop', next: reset(), reason: `short-blip(${speechChunks}块语音)` };
  }

  // 闸门 2：时长到上限 —— 和「有没有足够语音」是独立的，这是旧实现的漏洞。
  if (durationMs >= config.maxSegmentMs) {
    if (enoughSpeech) return { action: 'finish', next: reset(), reason: 'max-duration' };
    return { action: 'drop', next: reset(), reason: 'max-duration-too-short' };
  }

  // 闸门 3：字节硬上限（双保险，永远不该被用到）。
  if (bytes >= config.maxSegmentBytes) {
    if (enoughSpeech) return { action: 'finish', next: reset(), reason: 'max-bytes' };
    return { action: 'drop', next: reset(), reason: 'max-bytes-too-short' };
  }

  return { action: 'append', next };
}

function reset(): SegmentState {
  return { ...EMPTY_SEGMENT };
}

/**
 * 一段话的真实音频时长（毫秒）。
 *
 * 临时结果、最终分段、延迟统计统一走这一个口径，别再各算各的
 * （`speechChunks + silenceChunks` 会漏算中途停顿，见 SegmentState.totalChunks）。
 */
export function segmentAudioMs(state: SegmentState, chunkMs: number): number {
  return state.totalChunks * chunkMs;
}

/** 把「单段最长毫秒」换算成「单段最多字节」（16kHz 单声道 int16）。 */
export function maxBytesForMs(ms: number, sampleRate: number): number {
  return Math.round((sampleRate * ms) / 1000) * 2;
}
