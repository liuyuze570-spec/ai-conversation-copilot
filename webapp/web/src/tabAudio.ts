/**
 * P2「翻译其他网页视频」：浏览器侧授权捕获 + 短切片识别编排。
 *
 * 诚实边界（界面也要照这个说）：
 * - 必须由使用者亲自点按钮、亲自在浏览器弹窗里选标签页并勾选「分享标签页音频」；
 * - 只用 `getDisplayMedia` 拿到的**音频轨**，绝不退回麦克风冒充；
 * - video 轨只用来维持捕获会话，**不接元素、不取帧、不上传画面**；
 * - 无音轨 / 无声音 / 取消授权都给明确状态，不生成任何字幕；
 * - 不把捕获到的声音回放到扬声器（静音增益 0），避免助手朗读被再次识别成循环；
 * - 每个片段只做识别 + 断句 + 翻译，**不对每小片段生成回复**；
 * - 停止时 abort 在途请求、清空队列、停掉所有轨道、关闭 AudioContext。
 *
 * `startWithStream()` 是给自动化自检用的注入口：它接的是本地合成 WAV 解码出来的
 * 真实 MediaStream，用来验证「切片→识别→翻译」链路，**不会**被标成视频原声。
 * 真人授权标签页那一步无法由脚本代替，文档里单列「未自动化验证」。
 */

import {
  chunkForTranslation,
  dedupeSegment,
  downsample,
  isSilent,
  pcmToWav,
  splitSentences,
} from '@shared/caption-pipeline';
import {
  transcribeSegment,
  translate as apiTranslate,
  withSession,
  type SourceLanguage,
} from './api';

export type CaptureState =
  | 'idle'
  | 'requesting'
  | 'capturing'
  | 'waiting-sound'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface CaptureLine {
  seq: number;
  text: string;
  translation: string;
  /** true = 没有等到句号，靠静音/超长强制收的尾，界面要标「半句」。 */
  partial: boolean;
  asrMode: string;
  translateMode: string;
  asrMs: number;
  translateMs: number;
  /** 切片结束到字幕出现。 */
  totalMs: number;
}

export interface CaptureStats {
  slices: number;
  sent: number;
  silent: number;
  dropped: number;
  lines: number;
  budgetLeft: number | null;
  asrMs: number[];
  translateMs: number[];
  totalMs: number[];
}

/**
 * 第二条轨道：整段连贯翻译。
 *
 * 逐句轨一条一条出、保持不变；这一轨把**到目前为止全部**句子合起来翻一次，
 * 由「暂停」或「停止」自动触发。继续采集后新句子会让它变 stale，
 * 界面必须明说「有 N 句还没纳入」，不能拿旧译文冒充实时。
 */
export interface PassageTranslation {
  status: 'idle' | 'translating' | 'done' | 'error';
  /** 已经翻进译文的原文（分块拼接后的范围）。 */
  text: string;
  translation: string;
  /** 覆盖到第几句 / 目前共几句。 */
  covered: number;
  total: number;
  /** 分了几块、各块走的翻译模式。 */
  chunks: number;
  modes: string[];
  /** 块数上限之外没能纳入的句子数。 */
  omitted: number;
  /** 继续采集后又有新句子，译文已过期。 */
  stale: boolean;
  /** 这次是谁触发的：pause / stop / manual。界面要能说明「停止会自动翻译」。 */
  trigger: string;
  ms: number;
  error: string;
}

export function emptyPassage(): PassageTranslation {
  return {
    status: 'idle', text: '', translation: '', covered: 0, total: 0,
    chunks: 0, modes: [], omitted: 0, stale: false, trigger: '',
    ms: 0, error: '',
  };
}

export interface CaptureCallbacks {
  onState: (state: CaptureState, detail: string) => void;
  onLine: (line: CaptureLine) => void;
  onStats: (stats: CaptureStats) => void;
  onError: (code: string, message: string) => void;
  /** 累积的全部成句原文（暂停/继续都不清空，直到下一次新会话）。 */
  onTranscript?: (sentences: string[]) => void;
  onPassage?: (passage: PassageTranslation) => void;
}

export interface CaptureOptions extends CaptureCallbacks {
  sliceSeconds?: number;
  silenceThreshold?: number;
  language?: SourceLanguage;
}

const MAX_QUEUE = 3;
const TARGET_RATE = 16000;
const WORKLET_BLOCK = 4096;
const MAX_CARRY_CHARS = 180;
const SILENT_FLUSH_SLICES = 3;

const WORKLET_SOURCE = `
class CopilotPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.frames = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      const copy = new Float32Array(channel);
      this.chunks.push(copy);
      this.frames += copy.length;
      if (this.frames >= ${WORKLET_BLOCK}) {
        const merged = new Float32Array(this.frames);
        let offset = 0;
        for (const part of this.chunks) { merged.set(part, offset); offset += part.length; }
        this.port.postMessage(merged, [merged.buffer]);
        this.chunks = [];
        this.frames = 0;
      }
    }
    // 输出全静音：保持音频图被驱动，但绝不把视频声音再放一遍。
    const out = outputs[0] && outputs[0][0];
    if (out) out.fill(0);
    return true;
  }
}
registerProcessor('copilot-pcm', CopilotPCM);
`;

interface DisplayOptions {
  video: boolean;
  audio: boolean;
  systemAudio?: string;
  selfBrowserSurface?: string;
  surfaceSwitching?: string;
}

function concatFrames(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 取走前 frames 帧，剩下的留给下一片，不丢采样。 */
function takeFrames(
  chunks: Float32Array[],
  frames: number,
): { slice: Float32Array; rest: Float32Array[] } {
  const out = new Float32Array(frames);
  const rest: Float32Array[] = [];
  let written = 0;
  for (const chunk of chunks) {
    if (written >= frames) {
      rest.push(chunk);
      continue;
    }
    const need = frames - written;
    if (chunk.length <= need) {
      out.set(chunk, written);
      written += chunk.length;
    } else {
      out.set(chunk.subarray(0, need), written);
      written = frames;
      rest.push(chunk.subarray(need));
    }
  }
  return { slice: out, rest };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class TabAudioSession {
  private opts: Required<Omit<CaptureOptions, keyof CaptureCallbacks>> & CaptureCallbacks;
  private generation = 0;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletUrl: string | null = null;
  private sourceLabel = '';
  private controllers = new Set<AbortController>();
  private queue: number[] = [];
  private slices = new Map<number, { bytes: Uint8Array; capturedAt: number }>();
  private pumping = false;
  private nextSeq = 0;
  private carry = '';
  private recent: string[] = [];
  private silentStreak = 0;
  private stats: CaptureStats = {
    slices: 0, sent: 0, silent: 0, dropped: 0, lines: 0,
    budgetLeft: null, asrMs: [], translateMs: [], totalMs: [],
  };
  private endedHandler: (() => void) | null = null;
  private transcript: string[] = [];
  private passage: PassageTranslation = emptyPassage();
  private paused = false;
  private passageToken = 0;
  private disposed = false;

  constructor(options: CaptureOptions) {
    this.opts = {
      sliceSeconds: options.sliceSeconds ?? 3,
      silenceThreshold: options.silenceThreshold ?? 0.008,
      language: options.language ?? 'en',
      onState: options.onState,
      onLine: options.onLine,
      onStats: options.onStats,
      onError: options.onError,
      onTranscript: options.onTranscript,
      onPassage: options.onPassage,
    };
  }

  get label(): string {
    return this.sourceLabel;
  }

  /** 真人入口：浏览器弹窗由使用者自己选标签页，脚本无法代替。 */
  async start(): Promise<void> {
    const media = navigator.mediaDevices;
    if (!media || typeof media.getDisplayMedia !== 'function') {
      this.fail('UNSUPPORTED', '这个浏览器不支持标签页音频捕获。请用桌面版 Chrome 或 Edge 再试。');
      return;
    }
    this.opts.onState('requesting', '等待你在浏览器弹窗里选择标签页并勾选「分享标签页音频」');
    let stream: MediaStream;
    try {
      // Chrome/Edge 只有在同时请求 video 时才会列出「标签页」并允许共享标签页音频。
      // 这几个选项不在所有 TS DOM 版本里，故显式收窄调用签名。
      const request = media.getDisplayMedia as (options: DisplayOptions) => Promise<MediaStream>;
      stream = await request.call(media, {
        video: true,
        audio: true,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'AbortError') {
        this.fail('USER_CANCELLED', '你取消了选择，或浏览器拒绝了捕获。没有开始任何采集。');
      } else {
        this.fail('CAPTURE_FAILED', `标签页捕获失败：${describeError(error)}`);
      }
      return;
    }
    await this.attach(stream, 'video-tab');
  }

  /** 自检入口：注入一条真实音频 MediaStream（不是视频原声，界面会如实标注）。 */
  async startWithStream(stream: MediaStream, label: string): Promise<void> {
    await this.attach(stream, label);
  }

  private async attach(stream: MediaStream, label: string): Promise<void> {
    const generation = ++this.generation;
    this.resetRuntime();
    // 新一轮授权 = 新一轮全文。暂停/继续不清空，停止后也保留供查看。
    this.transcript = [];
    this.passage = emptyPassage();
    this.paused = false;
    this.passageToken += 1;
    this.stream = stream;
    this.sourceLabel = label;
    this.opts.onTranscript?.([]);
    this.emitPassage();

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0 || audioTracks.every((track) => track.readyState !== 'live')) {
      // 没勾「分享标签页音频」时 Chrome 会返回一个只有 video 的流。
      // 这里必须停干净并明确报错，绝不能拿麦克风顶上。
      this.stopTracks();
      this.fail(
        'NO_AUDIO_TRACK',
        '选择的标签页没有音频轨。请在浏览器弹窗里勾选「分享标签页音频」，或换一个正在出声的标签页。',
      );
      return;
    }

    try {
      const AudioContextCtor = window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error('AudioContext 不可用');
      const context = new AudioContextCtor();
      this.context = context;
      await context.resume();
      if (generation !== this.generation) {
        void context.close();
        return;
      }
      if (!context.audioWorklet) throw new Error('AudioWorklet 不可用');

      const url = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'text/javascript' }),
      );
      this.workletUrl = url;
      await context.audioWorklet.addModule(url);

      const node = new AudioWorkletNode(context, 'copilot-pcm', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.workletNode = node;
      // 只把音频轨接进来；video 轨保持 live 但不接任何元素、不读帧、不上传。
      const source = context.createMediaStreamSource(new MediaStream([audioTracks[0]]));
      source.connect(node);
      const silentGain = context.createGain();
      silentGain.gain.value = 0;
      node.connect(silentGain);
      silentGain.connect(context.destination);

      const sliceFrames = Math.max(1, Math.round(this.opts.sliceSeconds * context.sampleRate));
      let chunks: Float32Array[] = [];
      let frames = 0;
      node.port.onmessage = (event: MessageEvent) => {
        if (generation !== this.generation) return;
        if (this.paused) {
          // 暂停时音频轨仍 live、worklet 仍在推数据。直接丢掉，
          // 否则「继续」会把暂停那段一起识别出来，等于没停。
          chunks = [];
          frames = 0;
          return;
        }
        const chunk = new Float32Array(event.data as ArrayLike<number>);
        chunks.push(chunk);
        frames += chunk.length;
        while (frames >= sliceFrames) {
          const taken = takeFrames(chunks, sliceFrames);
          chunks = taken.rest;
          frames -= sliceFrames;
          this.onSlice(generation, taken.slice, context.sampleRate);
        }
      };

      this.endedHandler = () => {
        if (generation !== this.generation) return;
        void this.stop().then(() => {
          this.fail('TRACK_ENDED', '标签页音频轨已结束（视频标签页可能被关闭或停止共享）。采集已停止。');
        });
      };
      audioTracks[0].addEventListener('ended', this.endedHandler);

      this.opts.onState('capturing', `正在采集：${audioTracks.length} 条音频轨 · ${Math.round(context.sampleRate / 1000)}kHz · 每 ${this.opts.sliceSeconds} 秒一片`);
      this.emitStats();
    } catch (error) {
      this.stopTracks();
      this.fail('AUDIO_CONTEXT_FAILED', `无法建立音频切片：${describeError(error)}`);
    }
  }

  private onSlice(generation: number, pcm: Float32Array, sampleRate: number): void {
    if (generation !== this.generation) return;
    this.stats.slices += 1;
    if (isSilent(pcm, this.opts.silenceThreshold)) {
      this.stats.silent += 1;
      this.silentStreak += 1;
      this.opts.onState('waiting-sound', '没有检测到声音，等待中（不会生成字幕）');
      if (this.silentStreak >= SILENT_FLUSH_SLICES && this.carry.trim()) {
        void this.flushCarry(generation);
      }
      this.emitStats();
      return;
    }
    this.silentStreak = 0;
    this.opts.onState('capturing', '正在识别并翻译');
    const reduced = downsample(pcm, sampleRate, TARGET_RATE);
    const bytes = pcmToWav(reduced, TARGET_RATE);
    const seq = ++this.nextSeq;
    if (this.queue.length >= MAX_QUEUE) {
      const dropped = this.queue.shift();
      if (dropped !== undefined) this.slices.delete(dropped);
      this.stats.dropped += 1;
    }
    this.queue.push(seq);
    this.slices.set(seq, { bytes, capturedAt: performance.now() });
    this.stats.sent += 1;
    this.emitStats();
    void this.pump(generation);
  }

  private async pump(generation: number): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && generation === this.generation) {
        const seq = this.queue.shift();
        if (seq === undefined) break;
        const item = this.slices.get(seq);
        this.slices.delete(seq);
        if (!item) continue;
        await this.processSegment(generation, seq, item.bytes, item.capturedAt);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async processSegment(
    generation: number,
    seq: number,
    bytes: Uint8Array,
    capturedAt: number,
  ): Promise<void> {
    const signal = this.newSignal();
    const started = performance.now();
    let heardText = '';
    let asrMode = '';
    try {
      // Blob 只含 PCM 音频；没有任何视频帧、屏幕截图或画面数据。
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const heard = await withSession(
        () => transcribeSegment(blob, seq, signal, this.opts.language),
        signal,
      );
      if (generation !== this.generation) return;
      heardText = heard.text || '';
      asrMode = heard.mode;
      if (typeof heard.audio_budget_left_seconds === 'number') {
        this.stats.budgetLeft = heard.audio_budget_left_seconds;
      }
      this.stats.asrMs.push(Math.round(performance.now() - started));
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return;
      this.opts.onError('TRANSCRIBE_FAILED', `第 ${seq} 段识别失败：${describeError(error)}`);
      this.emitStats();
      return;
    }

    const text = dedupeSegment(this.recent, heardText);
    if (!text) {
      this.emitStats();
      return;
    }
    const combined = [this.carry, text].filter(Boolean).join(' ').trim();
    const { sentences, rest } = splitSentences(combined);
    this.carry = rest;
    if (this.carry.length > MAX_CARRY_CHARS) {
      void this.flushCarry(generation);
    }
    for (const sentence of sentences) {
      if (generation !== this.generation) return;
      await this.emitLine(generation, seq, sentence, false, asrMode, capturedAt);
    }
    this.emitStats();
  }

  /** 没有句号但已经静音/超长：把缓冲当「半句」出字幕，明确标注 partial。 */
  private async flushCarry(generation: number): Promise<void> {
    const pending = this.carry.trim();
    if (!pending || generation !== this.generation) return;
    this.carry = '';
    this.silentStreak = 0;
    const seq = this.nextSeq;
    await this.emitLine(generation, seq, pending, true, 'carried', performance.now());
    this.emitStats();
  }

  private async emitLine(
    generation: number,
    seq: number,
    sentence: string,
    partial: boolean,
    asrMode: string,
    capturedAt: number,
  ): Promise<void> {
    const signal = this.newSignal();
    const started = performance.now();
    let translation = '';
    let translateMode = 'failed';
    try {
      const result = await withSession(
        () => apiTranslate(sentence, signal, this.opts.language),
        signal,
      );
      if (generation !== this.generation) return;
      translation = result.translation;
      translateMode = result.mode;
      this.stats.translateMs.push(Math.round(performance.now() - started));
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return;
      // 翻译失败也要把识别到的原文留下来，不能整句丢掉，更不能编一句中文顶上。
      translation = '';
      this.opts.onError('TRANSLATE_FAILED', `这句翻译失败，原文已保留：${describeError(error)}`);
    }
    const totalMs = Math.round(performance.now() - capturedAt);
    this.stats.totalMs.push(totalMs);
    this.stats.lines += 1;
    this.recent.push(sentence);
    if (this.recent.length > 6) this.recent = this.recent.slice(-6);
    this.transcript.push(sentence);
    this.opts.onTranscript?.([...this.transcript]);
    // 继续采集后新句子进来了：整段译文立刻标「已过期」，不冒充实时。
    if (this.passage.status !== 'idle') {
      this.passage = {
        ...this.passage,
        total: this.transcript.length,
        stale: this.passage.status === 'done' && this.transcript.length > this.passage.covered,
      };
      this.emitPassage();
    }
    const line: CaptureLine = {
      seq,
      text: sentence,
      translation,
      partial,
      asrMode,
      translateMode,
      asrMs: this.stats.asrMs.at(-1) ?? 0,
      translateMs: this.stats.translateMs.at(-1) ?? 0,
      totalMs,
    };
    this.opts.onLine(line);
    this.emitStats();
  }

  private newSignal(): AbortSignal {
    const controller = new AbortController();
    this.controllers.add(controller);
    return controller.signal;
  }

  private emitStats(): void {
    this.opts.onStats({ ...this.stats });
  }

  private fail(code: string, message: string): void {
    this.opts.onState('error', message);
    this.opts.onError(code, message);
  }

  private stopTracks(): void {
    if (this.endedHandler && this.stream) {
      for (const track of this.stream.getAudioTracks()) {
        track.removeEventListener('ended', this.endedHandler);
      }
    }
    this.endedHandler = null;
    if (this.stream) {
      // video 轨也要停：它一直没被读取，但不停会留下悬挂的捕获会话。
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;
  }

  private resetRuntime(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.queue = [];
    this.slices.clear();
    this.pumping = false;
    this.paused = false;
    this.nextSeq = 0;
    this.carry = '';
    this.recent = [];
    this.silentStreak = 0;
    this.stats = {
      slices: 0, sent: 0, silent: 0, dropped: 0, lines: 0,
      budgetLeft: null, asrMs: [], translateMs: [], totalMs: [],
    };
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.context) {
      void this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    this.stopTracks();
  }

  private emitPassage(): void {
    if (!this.disposed) this.opts.onPassage?.({ ...this.passage });
  }

  /** 手动刷新整段译文（继续采集后译文过期时可用）。 */
  async refreshPassage(): Promise<void> {
    await this.translatePassage('manual');
  }

  /**
   * 暂停：停止切片与排队，但**保留音频轨**，所以「继续」不用再选一次标签页。
   * 同时把到目前为止的全部句子整段翻一次 —— 用户说「停止，自动翻译」。
   */
  async pause(): Promise<void> {
    if (!this.stream || this.paused) return;
    this.paused = true;
    // 没等到句号的半句也要算进全文，否则暂停会丢掉最后一段话。
    const pending = this.carry.trim();
    if (pending) {
      this.carry = '';
      this.transcript.push(pending);
      this.opts.onTranscript?.([...this.transcript]);
    }
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.queue = [];
    this.slices.clear();
    this.pumping = false;
    this.silentStreak = 0;
    this.opts.onState('paused', '已暂停，正在把到目前为止的全部内容整段翻译');
    this.emitStats();
    await this.translatePassage('pause');
  }

  /** 继续：恢复切片，全文接着累积；下次暂停/停止会刷新整段译文。 */
  resume(): void {
    if (!this.stream || !this.paused) return;
    this.paused = false;
    this.opts.onState('capturing', '继续采集，整段译文会在下次暂停或停止时更新');
    this.emitStats();
  }

  /**
   * 第二条轨道：把累积全文按句子分块，逐块走真实翻译模型，再拼成整段译文。
   * 不做「每句一翻」—— 那正是用户觉得慢的地方；也不凭空生成译文。
   */
  private async translatePassage(reason: 'pause' | 'stop' | 'manual'): Promise<void> {
    const token = ++this.passageToken;
    const sentences = [...this.transcript];
    if (!sentences.length) {
      this.passage = {
        ...emptyPassage(), status: 'done', trigger: reason,
        error: '还没有识别到成句的字幕，没有内容可整段翻译。',
      };
      this.emitPassage();
      return;
    }

    const { chunks, omitted, oversized } = chunkForTranslation(sentences, 500, 4);
    const covered = chunks.reduce((sum, item) => sum + (item.to - item.from), 0);
    const started = performance.now();
    this.passage = {
      status: 'translating',
      text: sentences.slice(sentences.length - covered).join(' '),
      translation: '', covered: 0, total: sentences.length,
      chunks: chunks.length, modes: [], omitted, stale: false,
      trigger: reason, ms: 0, error: '',
    };
    this.emitPassage();

    const controller = new AbortController();
    this.controllers.add(controller);
    const parts: string[] = [];
    const modes: string[] = [];
    const failures: number[] = [];
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        if (token !== this.passageToken || controller.signal.aborted) return;
        try {
          const result = await withSession(
            () => apiTranslate(chunks[index].text, controller.signal, this.opts.language),
            controller.signal,
          );
          if (token !== this.passageToken) return;
          parts.push(result.translation);
          modes.push(result.mode);
          this.passage = {
            ...this.passage,
            translation: parts.join('\n'),
            covered: chunks.slice(0, index + 1).reduce((sum, item) => sum + (item.to - item.from), 0),
            modes: [...modes],
            total: this.transcript.length,
            ms: Math.round(performance.now() - started),
          };
          this.emitPassage();
        } catch (error) {
          if (controller.signal.aborted || token !== this.passageToken) return;
          failures.push(index + 1);
          // 失败那块留一个显式占位，绝不拿英文原文或现成中文顶上。
          parts.push(`（第 ${index + 1} 段翻译失败，未生成译文）`);
        }
      }
      if (token !== this.passageToken) return;
      const anySuccess = parts.some((_part, index) => !failures.includes(index + 1));
      this.passage = {
        ...this.passage,
        status: anySuccess ? 'done' : 'error',
        translation: parts.join('\n'),
        modes: [...modes],
        total: this.transcript.length,
        stale: this.transcript.length > covered,
        ms: Math.round(performance.now() - started),
        error: [
          omitted ? `超过分块上限，最早 ${omitted} 句未纳入整段翻译` : '',
          oversized ? `${oversized} 句本身超长，单独成块（可能被服务端拒绝）` : '',
          failures.length ? `第 ${failures.join('、')} 段翻译失败` : '',
        ].filter(Boolean).join('；'),
      };
      this.emitPassage();
    } finally {
      this.controllers.delete(controller);
    }
  }

  /** 组件卸载：丢掉在途结果，不再往已卸载的组件里 setState。 */
  dispose(): void {
    this.disposed = true;
    this.passageToken += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  /** 停止：abort 在途、清空排队、释放全部轨道，并自动做一次整段翻译。 */
  async stop(options?: { translate?: boolean }): Promise<void> {
    this.generation += 1;
    // 停止后仍要能看到这一轮的切片数、延迟和预算余量，不能清成 0。
    const finalStats = { ...this.stats };
    this.opts.onState('stopping', '正在取消排队并释放采集轨道');
    this.resetRuntime();
    this.stats = finalStats;
    this.sourceLabel = '';
    this.opts.onState('stopped', '已停止，所有采集轨道已释放');
    this.emitStats();
    // 用户停止 → 自动按全部内容整段翻译。不 await：停止本身必须即时。
    if (options?.translate !== false && !this.disposed) {
      void this.translatePassage('stop');
    }
  }
}
