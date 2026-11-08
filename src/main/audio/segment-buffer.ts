/**
 * 一段话的音频缓冲区（攒块 → 拼成完整音频 → 重置）。
 *
 * ## 为什么要有这个文件
 *
 * 0.3.6 里这段逻辑内联在 `AudioStream.handleFrame`，写法是：
 *
 * ```ts
 * const decision = decideSegment(this.segmentState, ...);
 * this.segmentState = decision.next;        // finish 时 next 是 reset()，bytes 变 0
 * ...
 * case 'finish':
 *   this.segmentChunks.push(frame);
 *   const pcm = this.snapshotSegment();     // Buffer.concat(chunks, this.segmentState.bytes)
 * ```
 *
 * `Buffer.concat(list, 0)` 返回的是**零长度 Buffer**。于是每一次「收官」都拼出一段
 * 空音频，`pcm.length >= MIN_FINAL_MS` 永远不成立 —— 最终识别**从来没有被提交过**，
 * 字幕会一直停在半句 `partial` 上。这个 bug 在界面上看起来像「识别不准」，
 * 实际是「整句根本没发出去」，极难从日志看出来（日志只打 `interim -> ...`）。
 *
 * 状态机的单测只验证「返回 finish」，验证不到这一步 —— 所以这里把
 * 「攒块 + 拼接 + 重置」变成一个可独立测试的对象，并用**先拼接、后重置**的
 * 写法把顺序钉死：`finish` 分支里 pcm 在 reset 之前就已经造好了。
 */

import {
  EMPTY_SEGMENT,
  decideSegment,
  segmentAudioMs,
  type SegmentConfig,
  type SegmentState,
  type Thresholds,
} from '../../shared/segment-vad';

export type SegmentOutcome =
  /** 静音帧，丢掉。 */
  | { action: 'idle' }
  /** 开了一段新话，这一帧已经收进缓冲区。 */
  | { action: 'start' }
  /** 追加了一帧。 */
  | { action: 'append' }
  /** 这一段收官：`pcm` 是**完整**音频（非空），调用方负责提交识别。 */
  | { action: 'finish'; pcm: Buffer; durationMs: number; reason?: string }
  /** 这一段整段丢弃（短噪声 / 超限）。 */
  | { action: 'drop'; reason?: string };

export class SegmentBuffer {
  private chunks: Buffer[] = [];
  private state: SegmentState = { ...EMPTY_SEGMENT };

  /** 状态机当前状态（只读，给引擎算中途快照用）。 */
  get info(): SegmentState {
    return this.state;
  }

  get durationMs(): number {
    return segmentAudioMs(this.state, this.config.chunkMs);
  }

  private readonly config: SegmentConfig;

  constructor(config: SegmentConfig) {
    this.config = config;
  }

  /**
   * 收一帧。
   *
   * 注意顺序：`finish` / `drop` 分支里先把音频拼好，再把状态和块数组清空。
   * 反过来写（先清状态再拼接）就会踩到文件开头说的那个 bug。
   */
  push(frame: Buffer, rms: number, thresholds: Thresholds, vadSilenceMs: number): SegmentOutcome {
    const decision = decideSegment(
      this.state,
      { rms, bytes: frame.length },
      thresholds,
      { ...this.config, vadSilenceMs },
    );

    switch (decision.action) {
      case 'idle':
        return { action: 'idle' };

      case 'start':
        this.state = decision.next;
        this.chunks = [Buffer.from(frame)];
        return { action: 'start' };

      case 'append':
        this.state = decision.next;
        this.chunks.push(Buffer.from(frame));
        return { action: 'append' };

      case 'finish': {
        // 这一帧也属于这一段（它是触发收官的那一帧）。
        this.chunks.push(Buffer.from(frame));
        // 时长要用「这一帧之前的状态 + 这一帧」算：decision.next 已经重置成 0 了。
        const durationMs = segmentAudioMs(this.state, this.config.chunkMs) + this.config.chunkMs;
        // 先拼接 —— 此时块数组还是完整的。
        const pcm = this.snapshot();
        // 再重置。
        this.state = { ...EMPTY_SEGMENT };
        this.chunks = [];
        return { action: 'finish', pcm, durationMs, reason: decision.reason };
      }

      case 'drop': {
        this.state = { ...EMPTY_SEGMENT };
        this.chunks = [];
        return { action: 'drop', reason: decision.reason };
      }
    }
  }

  /**
   * 当前已攒下的音频。
   *
   * **长度一律由块本身算**，不接受外部传入的字节数 —— 之前那个参数就是 bug 的入口：
   * 调用方一旦在重置之后才来取快照，传进去的 0 会把整段音频抹成空。
   */
  snapshot(): Buffer {
    if (!this.chunks.length) return Buffer.alloc(0);
    if (this.chunks.length === 1) return this.chunks[0];
    return Buffer.concat(this.chunks);
  }

  clear(): void {
    this.chunks = [];
    this.state = { ...EMPTY_SEGMENT };
  }
}
