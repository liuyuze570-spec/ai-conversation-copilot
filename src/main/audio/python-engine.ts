import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  IPC,
  type AudioLevelPayload,
  type AudioProbeResult,
  type TranscriptPayload,
  type AudioStatusPayload,
} from '../../shared/ipc';
import { logger } from '../logger';
import { getSettingsStore } from '../settings-store';
import { beginTrace, recordStt } from '../latency';
import { getSTT, hasSttKey } from '../ai-service';
import { describeAiError } from '../../shared/ai-errors';
import { sttLanguageCode } from '../../shared/types';
import { signalHealsStatus, healsAfterSuccess } from './status-heal';
import { computeThresholds, nextRecentPeak } from '../../shared/adaptive-vad';
import { resolveSources } from '../../shared/sources';
import {
  maxBytesForMs,
  segmentAudioMs,
  type SegmentConfig,
} from '../../shared/segment-vad';
import { SegmentBuffer } from './segment-buffer';
import type { AudioEngine } from './mock-engine';

const SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'python', 'loopback.py')
  : path.join(__dirname, '../../../src/python/audio_capture/loopback.py');

const SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (SAMPLE_RATE * CHUNK_MS / 1000) * 2; // mono int16
const MIN_SPEECH_CHUNKS = 3; // ignore very short blips
const INTERIM_INTERVAL_MS = 2500;
/**
 * 一段话最长多少毫秒就强制收官。
 *
 * 电影对白 + 背景音乐时，能量几乎不会掉到静音阈值以下，段会无限增长，
 * 最后送一整段几分钟的音频去识别 —— 模型要么超时、要么只吐出开头一句，
 * 表现出来就是「字幕老是缺半句 / 对不上」。
 */
const MAX_SEGMENT_MS = 12_000;
/** 送去识别的最短音频长度：太短的片段基本只能识别出噪声。 */
const MIN_FINAL_MS = 350;
const MIN_INTERIM_MS = 1000;
/**
 * 一次识别请求的硬性上限。
 *
 * 识别客户端自己也有超时（默认 60 秒）+ 1 次重试，最坏情况 120 秒。而转录是
 * **串行**的：一个请求卡住，后面所有句子都在排队，字幕直接停摆两分钟 ——
 * 用户看到的就是「第一轮完了之后就没有第二轮了」。
 * 这里再压一道闸：到点就放弃这一段，把队列让给下一句。
 */
const TRANSCRIBE_DEADLINE_MS = 25_000;
/**
 * 队列最多排几段。
 *
 * 识别跟不上时（网络慢 / 上游抖动）不能让音频无限堆积：越堆越旧，字幕会
 * 越落越远，最后全部过时。超出的丢掉最老的 —— 丢掉的本来就是最不相关的。
 */
const MAX_QUEUE_BACKLOG = 4;
/**
 * 单段缓存字节的硬上限。
 *
 * 时长上限（12 秒）已经能兜住绝大多数情况，但「字节上限」是独立的最后一道闸：
 * 万一采样率、声道数被改过，或者块大小算错，也不至于把内存吃光。
 */
const MAX_SEGMENT_BYTES = maxBytesForMs(MAX_SEGMENT_MS * 1.5, SAMPLE_RATE);
/** 切句状态机的配置，纯逻辑在 shared/segment-vad.ts（有单测）。 */
const SEGMENT_CONFIG: SegmentConfig = {
  chunkMs: CHUNK_MS,
  minSpeechChunks: MIN_SPEECH_CHUNKS,
  maxSegmentMs: MAX_SEGMENT_MS,
  maxSegmentBytes: MAX_SEGMENT_BYTES,
  vadSilenceMs: 0, // 实际值每帧从设置读，见 handleFrame
};

/**
 * 「这是第几次开始监听」。
 *
 * 停止 / 重启监听时递增。每个音频流记住自己出生时的编号，发字幕前对一下：
 * 对不上就说明这条字幕来自**上一场对话**，必须丢掉。以前没有这个编号，
 * 停掉再开之后，上一轮还在路上的识别结果会直接写进新一场的字幕里 ——
 * 内容全是错的，而用户完全无从判断。
 */
let sessionSeq = 0;
let activeSessionId = 0;

/** 16 kHz 单声道 int16 下，ms 毫秒音频占多少字节。 */
function bytesForMs(ms: number): number {
  return Math.round((SAMPLE_RATE * ms) / 1000) * 2;
}

/**
 * 给 promise 套一个硬超时。
 *
 * `Promise.race` 里超时分支会赢，但原来那个 promise 仍在跑；对 fetch 来说
 * 无所谓（它的结果被丢弃），关键是**调用方一定会被唤醒**，串行队列才不会
 * 永久卡死。
 */
/**
 * 给一个 Promise 加总截止时间，**到点主动 abort 底层请求**。
 *
 * 旧实现只 reject，不 abort：调用方以为「这一段放弃了」，但底层 HTTP 请求
 * 还在跑（可能还要几十秒），连接和额度都白烧；而且它回来时若没有走到
 * `isStale()` 检查，还可能把旧内容写进新字幕。现在超时 = 真的取消。
 *
 * 返回 `timedOut()`，让调用方能区分「用户主动停止」和「真的超时」——
 * 两者在界面上是两种话：前者不该报错，后者必须告诉用户。
 */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller: AbortController,
): { promise: Promise<T>; timedOut: () => boolean } {
  let timedOut = false;
  const wrapped = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        /* 已经结束了 */
      }
      reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒没有响应）`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  return { promise: wrapped, timedOut: () => timedOut };
}

interface StreamOptions {
  speaker: 'foreign' | 'user';
  mode: 'loopback' | 'mic';
  deviceId: string;
  /** 这条流死了要通知上层（上层负责清指纹、让「重新连接」可用）。 */
  onDead?: (reason: string) => void;
  /** 丢了一段音频（队列积压 / 识别超时）时通知界面，别只写日志。 */
  onDropped?: (info: { at: number; reason: string }) => void;
  /** 每来一次音量采样就交给主控算「最近几秒还有没有声音」。 */
  onLevel?: (level: AudioLevelPayload) => void;
}

// --------------------------------------------------------------------------- //
// Python discovery
// --------------------------------------------------------------------------- //

let resolvedPython: string | null | undefined;

/**
 * Find a Python that can actually `import soundcard`.
 *
 * This used to be a single hard-coded venv path, so on any machine without
 * that exact folder the real capture pipeline died silently and the overlay
 * simply stayed empty forever.
 */
/**
 * 试跑一次「import soundcard, numpy」，看这个解释器能不能当 sidecar 用。
 *
 * `encoding: 'buffer'` 是刻意的：中文 Windows 上 Python 的报错可能是 GBK，
 * 交给 Node 自动解码会变成乱码，日志里就查不出原因了；这里统一按 UTF-8 解，
 * 解不出来也无所谓，至少 spawn 层的错误码是准的。
 */
function probePython(candidate: string): { ok: boolean; detail: string; spawnError: boolean } {
  try {
    const result = spawnSync(candidate, ['-c', 'import soundcard, numpy'], {
      timeout: 15000,
      windowsHide: true,
      encoding: 'buffer',
    });
    if (result.status === 0) return { ok: true, detail: 'ok', spawnError: false };
    if (result.error) {
      return { ok: false, detail: `spawn 失败：${result.error.message}`, spawnError: true };
    }
    const stderr = result.stderr ? Buffer.from(result.stderr).toString('utf8').trim() : '';
    return {
      ok: false,
      detail: stderr.slice(0, 160) || `退出码 ${result.status}`,
      spawnError: false,
    };
  } catch (error) {
    return { ok: false, detail: `调用异常：${String(error)}`, spawnError: true };
  }
}

/**
 * 随安装包分发的便携 Python 音频运行时。
 *
 * 这是「把软件发给朋友」能成立的前提：采集声音靠一个 Python 小程序，而朋友
 * 的电脑上多半既没装 Python、也没装 soundcard / numpy —— 那就会变成「装好了
 * 却永远听不到声音」。所以安装包自带一份（scripts/prepare-python-runtime.js
 * 组装），解压即用。
 */
function bundledRuntimePython(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'python-runtime', 'python.exe')]
    : [
        path.join(app.getAppPath(), 'vendor', 'python-runtime', 'python.exe'),
        path.join(process.cwd(), 'vendor', 'python-runtime', 'python.exe'),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function resolvePython(): string | null {
  if (resolvedPython !== undefined) return resolvedPython;

  const configured = getSettingsStore().get().audio.pythonPath?.trim();
  const bundled = bundledRuntimePython();
  const candidates = [
    configured,
    // 自带的排在开发机 venv 前面：它才是发布给用户的那个，优先被验证到。
    bundled,
    'C:/Users/25344/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'python',
    'python3',
    'py',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (!fs.existsSync(candidate)) continue;
    }
    let attempt = probePython(candidate);
    // 杀毒软件 / 系统刚启动时偶发会拒掉第一次 spawn（status=null）。不花钱再试一次。
    if (!attempt.ok && attempt.spawnError) {
      attempt = probePython(candidate);
    }
    if (attempt.ok) {
      logger.info(
        'Audio',
        `python sidecar: ${candidate}${candidate === bundled ? '（安装包自带）' : ''}`,
      );
      resolvedPython = candidate;
      return candidate;
    }
    logger.warn('Audio', `python candidate rejected (${candidate}): ${attempt.detail}`);
  }

  resolvedPython = null;
  return null;
}

export function pythonAvailability(): { available: boolean; command: string } {
  const resolved = resolvePython();
  return { available: Boolean(resolved), command: resolved ?? '' };
}

// --------------------------------------------------------------------------- //
// WAV helper
// --------------------------------------------------------------------------- //

/** Minimal WAV encoder for PCM16 mono @16 kHz. */
function encodeWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// --------------------------------------------------------------------------- //
// Sidecar event parsing
// --------------------------------------------------------------------------- //

type SidecarEvent =
  | {
      event: 'started';
      mode: string;
      device: string;
      deviceId: string;
      rate: number;
      channels: number;
      attempts?: string[];
      /** 端点音量 / 静音，读不到就没有（纯诊断用，见 shared/ipc.ts）。 */
      systemVolume?: number;
      systemMute?: boolean;
    }
  | {
      event: 'level';
      rms: number;
      peak: number;
      db: number;
      capturedSeconds: number;
      speaking: boolean;
    }
  | { event: 'silent'; seconds: number; device: string }
  | { event: 'error'; message: string };

class AudioStream {
  private process: ChildProcessWithoutNullStreams | null = null;
  private pending: Buffer = Buffer.alloc(0);
  /**
   * 当前这一段的缓冲区（攒块 + 拼接 + 重置）。
   *
   * 旧实现是三处内联：`segmentChunks` 数组、`segmentState`、`snapshotSegment()`。
   * 它们在 `handleFrame` 里的调用顺序曾经写反过 —— 先把状态重置（bytes → 0），
   * 再拿 `segmentState.bytes` 去 `Buffer.concat`，拼出来是空 Buffer，最终识别
   * 从来没被提交过。现在这件事由 `SegmentBuffer` 全权负责（见该文件注释），
   * 顺序在里面钉死，外面想写错也写不出来。
   */
  private segment: SegmentBuffer;
  /**
   * 环境噪声底噪。
   *
   * 旧实现的初始值是 300，而阈值是 `max(220, noiseFloor * 2.2)`，也就是开机
   * 前几秒门槛高达 660 —— 正常的说话开头几个字会被当成静音丢掉，字幕自然
   * 「对不上」。现在从 120 起步、限幅在 40..6000，收敛很快又不会被音乐带飞。
   */
  private noiseFloor = 120;
  /**
   * 最近听到过的最响一块（int16 RMS），带衰减。
   *
   * 只用来决定「要不要把切句门槛放松」：素材本身就很轻的时候（小声的对白、
   * 纪录片的环境音），固定的绝对门槛会把整段当成静音丢掉，一个字幕都切不出来，
   * 而界面上只显示「没有听到任何声音」。规则见 shared/adaptive-vad.ts。
   */
  private recentPeak = 0;
  private lastInterimAt = 0;
  /**
   * 「说完了」需要多长的静音（毫秒），带 500ms 缓存。
   *
   * 每帧（100ms）都去 `getSettingsStore().get()` 会做一次深拷贝 + 重建对象，
   * 一秒十次、一小时三万多次，纯属白烧。设置改动能容忍半秒延迟。
   */
  private vadSilenceMsCache = 0;
  private vadSilenceMsReadAt = 0;
  /**
   * 转录队列（串行的）。
   *
   * 旧实现用一个 `transcribing` 布尔当互斥量，撞上在途的「中途识别」时就把
   * **最终结果整个丢掉**：一段 2.5 秒以上的人声几乎必然撞上，于是字幕永远
   * 停在低置信度的半句话上；更糟的是那半句还是 `partial`，既不进上下文，
   * 也不会被翻译 —— 用户看到的就是「英文和中文对不上、准确率只有 60%」。
   *
   * 现在：最终结果一定会跑；排队的「中途结果」会被最终结果抢占（信息量更全）。
   */
  private queue: { pcm: Buffer; partial: boolean }[] = [];
  private draining = false;
  private stopped = false;
  private recentText: string[] = [];
  private stderrBuffer = '';
  private deviceName = '';
  /**
   * 上一次上报给界面的状态是不是「听不到东西」。
   *
   * 这是「第二轮监听不了」的根因之一：`silent` 事件只在上报后置一次，
   * 声音回来时**没有任何人去把它改回 `listening`**。而 renderer 里
   * 「对方停顿就自动生成回复」的看门狗是以 `status === 'listening'` 为门槛的，
   * 于是这个门槛一旦掉下去，整场对话的自动回复就永久失效了。
   * 有了这个标记，`level` 事件里一看到有信号就能把状态捞回来。
   */
  private reportedNoAudio = false;
  /** Only nag about a missing API key once per stream. */
  private warnedMissingKey = false;
  private capturedSeconds = 0;
  /** 上一次真正发给界面的状态，用来判断「成功后要不要把 error 捞回来」。 */
  private lastStatus: AudioStatusPayload['status'] = 'idle';
  /** 在途的识别请求，停止监听时要全部掐掉。 */
  private inflight = new Set<AbortController>();
  /** 这条流属于第几次「开始监听」。 */
  private readonly sessionId: number;
  /**
   * 「设备确认好了没有」。
   *
   * 0.3.x 的启动回执是假的：`spawn()` 一返回就报成功，而设备可能根本打不开
   * （被独占、被拔掉、采样格式不支持）。界面于是一路显示「正在采集」，
   * 一个字幕都没有。现在把 sidecar 的 `started` / `error` 折成一个 promise，
   * 上层等它 —— 拿不到就不许说成功。
   */
  private readyState: { ok: boolean; message: string; timedOut?: boolean } | null = null;
  /** 这一路是否已经上报过死亡（每条流只报一次，见 reportDead）。 */
  private deadReported = false;
  private readyWaiters: ((value: { ok: boolean; message: string; timedOut?: boolean }) => void)[] = [];

  constructor(
    private readonly win: Electron.BrowserWindow,
    private readonly options: StreamOptions,
  ) {
    this.sessionId = activeSessionId;
    this.segment = new SegmentBuffer(SEGMENT_CONFIG);
  }

  start() {
    const python = resolvePython();
    if (!python) {
      this.fail(
        '安装包自带的音频组件没找到（可能被杀毒软件拦截，或安装不完整）。' +
          '建议重新安装本软件；也可以在设置 → 音频里手动指定 python.exe。',
      );
      return;
    }
    const settings = getSettingsStore().get();
    const args = [
      SCRIPT,
      'stream',
      '--mode',
      this.options.mode,
      '--device',
      this.options.deviceId || 'default',
      '--rate',
      String(SAMPLE_RATE),
      '--channels',
      '2',
      '--chunk-ms',
      String(CHUNK_MS),
      '--sensitivity',
      String(settings.audio.sensitivity || 1),
    ];

    try {
      this.process = spawn(python, args, { windowsHide: true });
    } catch (error) {
      this.fail(`无法启动 Python 音频进程: ${String(error)}`);
      return;
    }

    this.process.stdout?.on('data', (chunk: Buffer) => this.onAudio(chunk));
    this.process.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    this.process.on('error', (error) => this.fail(`Python 进程错误: ${error.message}`));
    this.process.on('exit', (code) => {
      if (this.stopped) return;
      if (code && code !== 0) {
        this.fail(
          `音频捕获进程退出（code ${code}）。若设备被独占或被拔出，请重新开始监听。`,
        );
      } else {
        logger.info('Audio', `[${this.options.mode}] sidecar stopped (code ${code ?? 0})`);
        /*
         * code 0 也可能是异常结束：设备被切走时 sidecar 会正常退出。
         * 只要不是我们自己 stop 的，就当作「引擎死了」上报 —— 否则上层会一直
         * 以为它还在跑，用户点「开始」永远被跳过。
         */
        this.reportDead('采集进程已退出');
      }
    });

    logger.info('Audio', `${this.options.mode} stream started (${python})`);
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    // 在途的识别请求立刻掐掉：否则它会跑完、回来写字幕（还可能写进下一场），
    // 并且白烧一次识别额度。
    for (const controller of this.inflight) {
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    }
    this.inflight.clear();
    this.segment.clear();
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        /* already gone */
      }
      this.process = null;
    }
  }

  // ---- sidecar -> main ---------------------------------------------------

  private onStderr(chunk: Buffer) {
    this.stderrBuffer += chunk.toString('utf8');
    const lines = this.stderrBuffer.split('\n');
    this.stderrBuffer = lines.pop() ?? '';

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith('{')) {
        try {
          this.handleEvent(JSON.parse(line) as SidecarEvent);
          continue;
        } catch {
          /* fall through to plain text logging */
        }
      }
      if (line.startsWith('ERROR:')) {
        this.fail(line.slice(6).trim());
        continue;
      }
      /*
       * 走到这里的只可能是 sidecar 的异常输出（Python traceback / 解释器告警）——
       * 它约定只用 JSON 事件上报状态，识别正文永远不会出现在 stderr 上
       * （见 src/python/audio_capture/loopback.py 的 emit()）。这类信息是排查
       * 「sidecar 起不来」的唯一线索，所以要留，但截断长度避免异常刷屏。
       */
      logger.info('Audio', `[${this.options.mode}] sidecar stderr: ${line.slice(0, 160)}`);
    }
  }

  private handleEvent(payload: SidecarEvent) {
    switch (payload.event) {
      case 'started': {
        this.deviceName = payload.device;
        const detail = payload.attempts?.length
          ? ` (回退格式: ${payload.attempts[payload.attempts.length - 1]})`
          : '';
        logger.info(
          'Audio',
          `[${this.options.mode}] capture device = ${payload.device} @${payload.rate}Hz/${payload.channels}ch${detail}`,
        );
        if (typeof payload.systemMute === 'boolean') {
          // 只留个痕：系统静音**不影响**回环采集（实测差异 < 1%），
          // 记下来是为了日后排查「没字幕」时不会往静音这个方向误判。
          logger.info(
            'Audio',
            `[${this.options.mode}] 系统音量 ${Math.round((payload.systemVolume ?? 0) * 100)}%${
              payload.systemMute ? '（已静音，不影响采集）' : ''
            }`,
          );
        }
        this.reportedNoAudio = false;
        /*
         * 用户明确选了某个设备，sidecar 却开在别的设备上 → 必须说出来。
         *
         * 旧行为是「找不到就退到第一个回环设备」，界面上什么都不显示：
         * 用户以为自己选的是耳机，实际录的是显示器扬声器，字幕内容对不上
         * 还查不出原因。现在至少让状态条写清「实际用的是 X」。
         */
        const asked = this.options.deviceId;
        const fellBack = asked && asked !== 'default' && payload.deviceId && payload.deviceId !== asked;
        const message = fellBack
          ? `你选的设备没找到，已改用「${payload.device || '默认设备'}」`
          : this.listeningMessage(payload.device);
        if (fellBack) {
          logger.warn('Audio', `[${this.options.mode}] device fallback -> ${payload.device}`);
        }
        this.status('listening', message);
        this.settleReady({ ok: true, message });
        break;
      }
      case 'level': {
        this.capturedSeconds = payload.capturedSeconds;
        // 声音回来了就必须把状态捞回 `listening`，否则 renderer 里以
        // status==='listening' 为门槛的「停顿自动回复」看门狗会永久失效 ——
        // 表现就是「第一轮之后第二轮再也听不到 / 不自动回应」。
        if (signalHealsStatus(this.reportedNoAudio, payload)) {
          this.reportedNoAudio = false;
          logger.info('Audio', `[${this.options.mode}] signal back -> listening`);
          this.status('listening', this.listeningMessage(this.deviceName));
        }
        if (this.win.isDestroyed()) return;
        const level: AudioLevelPayload = {
          rms: payload.rms,
          peak: payload.peak,
          db: payload.db,
          speaking: payload.speaking,
          capturedSeconds: payload.capturedSeconds,
          source: this.options.mode === 'loopback' ? 'system' : 'mic',
          device: this.deviceName,
        };
        this.win.webContents.send(IPC.AUDIO_LEVEL, level);
        /*
         * 同时交给主控做「最近 8 秒有没有声音」的判断。
         *
         * sidecar 自己的 `silent` 事件只在跨过固定秒数时发一次，中途掉音
         * （切了输出设备、对方静音、耳机被拔）它不一定报；主控按滚动窗口
         * 算才能真正反映「现在还有没有声音进来」。
         */
        this.options.onLevel?.(level);
        break;
      }
      case 'silent': {
        logger.warn('Audio', `[${this.options.mode}] no signal for ${payload.seconds}s`);
        this.reportedNoAudio = true;
        this.status(
          'no-audio',
          this.options.mode === 'loopback'
            ? `已采集 ${this.capturedSeconds.toFixed(0)} 秒，但没有听到任何声音`
            : `已采集 ${this.capturedSeconds.toFixed(0)} 秒，麦克风没有收到声音`,
        );
        break;
      }
      case 'error': {
        this.fail(payload.message);
        break;
      }
    }
  }

  private fail(message: string) {
    logger.error('Audio', `[${this.options.mode}] ${message}`);
    this.status('error', message);
    // 设备没确认就失败 → 等启动回执的那一方立刻拿到结论，不必等到超时。
    this.settleReady({ ok: false, message });
    this.reportDead(message.slice(0, 60));
  }

  /**
   * 上报「这一路采集没了」。
   *
   * **同一条流只报一次**。0.4.0 的写法里 `fail()` 和 `exit` 事件都会调
   * `onDead`，于是一次设备错误会被数成两次死亡；双通道时两路各报两次，
   * 上层「全部通道都死了」的判断就提前成立，把还在工作的那一路也一起关掉。
   */
  private reportDead(reason: string) {
    if (this.deadReported) return;
    this.deadReported = true;
    this.options.onDead?.(reason);
  }

  private settleReady(value: { ok: boolean; message: string; timedOut?: boolean }) {
    if (this.readyState) return;
    this.readyState = value;
    for (const waiter of this.readyWaiters) waiter(value);
    this.readyWaiters = [];
  }

  /**
   * 等 sidecar 确认设备已打开。
   *
   * `timedOut` 与「明确失败」要分开：超时可能只是机器慢，进程还在，
   * 上层应该保留它并显示「正在连接」；明确失败则要清场并允许重连。
   */
  whenReady(ms: number): Promise<{ ok: boolean; message: string; timedOut?: boolean }> {
    if (this.readyState) return Promise.resolve(this.readyState);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          message: '音频进程已经启动，但 10 秒内还没有收到设备确认。可以点「重新连接」再试一次。',
          timedOut: true,
        });
      }, ms);
      this.readyWaiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private status(status: AudioStatusPayload['status'], message = '') {
    if (this.win.isDestroyed()) return;
    // 上一场监听的残留流不许改这一场的状态。
    if (this.sessionId !== activeSessionId) return;
    this.lastStatus = status;
    this.win.webContents.send(IPC.AUDIO_STATUS, { status, message });
  }

  /** 这条流是不是已经被「停止 / 重新开始」作废了。 */
  private isStale(): boolean {
    return this.stopped || this.sessionId !== activeSessionId;
  }

  private emit(payload: TranscriptPayload) {
    if (this.win.isDestroyed()) return;
    // 停止 / 重启之后，旧流识别出来的字幕一律丢掉 —— 那是上一场对话的内容。
    if (this.isStale()) {
      logger.info('Audio', `[${this.options.mode}] drop stale transcript (session ${this.sessionId})`);
      return;
    }
    this.win.webContents.send(IPC.AUDIO_TRANSCRIPT, {
      ...payload,
      sessionId: this.sessionId,
    });
  }

  /** 「正在监听 …」这句话在 started 与自愈两处都要用，抽出来免得写两遍走样。 */
  private listeningMessage(device: string): string {
    return this.options.mode === 'loopback'
      ? `正在监听系统声音 · ${device || '默认输出'}`
      : `正在监听麦克风 · ${device || '默认输入'}`;
  }

  // ---- audio -> VAD -> STT ----------------------------------------------

  private onAudio(chunk: Buffer) {
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : Buffer.from(chunk);

    while (this.pending.length >= BYTES_PER_CHUNK) {
      const frame = this.pending.subarray(0, BYTES_PER_CHUNK);
      this.handleFrame(frame);
      this.pending = this.pending.subarray(BYTES_PER_CHUNK);
    }
  }

  private handleFrame(frame: Buffer) {
    let sumSquares = 0;
    for (let i = 0; i < frame.length; i += 2) {
      const sample = frame.readInt16LE(i);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / (frame.length / 2));

    // 迟滞（双阈值）：起判门槛比续判门槛高。旧的单阈值会让说话中间的自然
    // 停顿把一句话切成两半，两半各翻一次，读起来就"对不上"。
    //
    // 门槛现在是自适应的（见 shared/adaptive-vad.ts）：只会因为「最近确实
    // 听到过很轻的信号」而放松，永远不会比原来的固定值 200 更严 —— 所以
    // 正常音量的行为完全不变，只有小声音乐/对白才从「全被丢掉」变成「能切出来」。
    this.recentPeak = nextRecentPeak(this.recentPeak, rms);
    const thresholds = computeThresholds(this.noiseFloor, this.recentPeak);

    // 切句决策与「攒块 / 拼接 / 重置」全部交给 SegmentBuffer（有单测，
    // 覆盖 handleFrame → finish → snapshot → enqueue 整条链）。
    // 它同时管四件事：短噪声要丢、时长上限要独立生效、字节上限兜底，
    // 以及**收官时先拼好音频再把状态清零**（写反就会拼出空音频）。
    const outcome = this.segment.push(
      frame,
      rms,
      thresholds,
      this.vadSilenceMs(),
    );

    switch (outcome.action) {
      case 'idle': {
        // 只在真正安静时学习环境噪声，并限幅——否则持续的背景音乐会把
        // 底噪一路抬高，最后连人声都被判成静音。
        this.noiseFloor = Math.min(6000, Math.max(40, this.noiseFloor * 0.94 + rms * 0.06));
        return;
      }
      case 'start': {
        this.lastInterimAt = Date.now();
        return;
      }
      case 'drop': {
        // 100–200ms 的短噪声（点鼠标、椅子响、播放器提示音）+ 之后的静音。
        // 以前这种段会永远不收官，把几十秒静音一路录进缓冲区（内存一路涨），
        // 还会把后面那句真话拖成一段又长又糊的音频。现在直接整段丢弃。
        if (outcome.reason) {
          logger.debug('Audio', `[${this.options.mode}] drop segment: ${outcome.reason}`);
        }
        return;
      }
      case 'finish': {
        if (outcome.reason && outcome.reason !== 'silence') {
          logger.info('Audio', `[${this.options.mode}] force finish: ${outcome.reason}`);
        }
        // 空音频说明拼接又坏了 —— 宁可报出来，也别让它静默变成「没有字幕」。
        if (!outcome.pcm.length) {
          logger.error('Audio', `[${this.options.mode}] finish produced empty pcm, dropped`);
          return;
        }
        if (outcome.durationMs >= MIN_FINAL_MS) this.enqueue(outcome.pcm, false);
        return;
      }
      case 'append': {
        // 中途结果：这一句还长着，先翻一版让字幕动起来。注意这里只是给当前段
        // 拍个快照，不打断这一段的累积 —— 最终的整句会覆盖同一张字幕卡。
        const durationMs = this.segment.durationMs;
        if (
          this.segment.info.speechChunks >= MIN_SPEECH_CHUNKS &&
          durationMs >= MIN_INTERIM_MS &&
          Date.now() - this.lastInterimAt >= INTERIM_INTERVAL_MS
        ) {
          this.lastInterimAt = Date.now();
          const snapshot = this.segment.snapshot();
          if (snapshot.length) this.enqueue(snapshot, true);
        }
        return;
      }
    }
  }

  /** 静音判定阈值，500ms 内复用同一个值（避免每帧深拷贝一次设置）。 */
  private vadSilenceMs(): number {
    const now = Date.now();
    if (now - this.vadSilenceMsReadAt > 500) {
      this.vadSilenceMsReadAt = now;
      this.vadSilenceMsCache = getSettingsStore().get().audio.vadSilenceMs;
    }
    return this.vadSilenceMsCache;
  }

  private enqueue(pcm: Buffer, partial: boolean) {
    // 同一个「正在长的那句话」的旧中途快照没有意义了 —— 新的更全。
    this.queue = this.queue.filter((job) => !job.partial);
    this.queue.push({ pcm, partial });
    // 有界队列：识别跟不上时（网络慢、上游抖动）丢掉最老的音频。
    // 不设上限的话会越堆越旧，字幕离实际对话越来越远，最后全部是过时的。
    if (this.queue.length > MAX_QUEUE_BACKLOG) {
      const dropped = this.queue.length - MAX_QUEUE_BACKLOG;
      this.queue.splice(0, dropped);
      logger.warn(
        'Audio',
        `[${this.options.mode}] 识别跟不上，丢弃 ${dropped} 段过时音频`,
      );
      /*
       * 丢的是**真的语音**，不是噪声。用户有权知道「这里少了一句」——
       * 只写日志等于让他以为字幕是完整的，然后拿漏掉的信息去做决定。
       */
      this.options.onDropped?.({
        at: Date.now(),
        reason: `识别速度跟不上，有 ${dropped} 段话没来得及转写`,
      });
    }
    void this.pump();
  }

  private async pump() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.isStale()) {
        const job = this.queue.shift() as { pcm: Buffer; partial: boolean };
        // 已经有最终结果在排队 → 中途结果直接跳过，把网络让给整句。
        if (job.partial && this.queue.some((item) => !item.partial)) continue;
        await this.runTranscribe(job.pcm, job.partial);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTranscribe(pcm: Buffer, partial: boolean) {
    if (this.isStale() || pcm.length === 0) return;

    // Capture keeps running without a key (so the level meter still proves the
    // audio is arriving) — we just stop hammering the endpoint.
    if (!hasSttKey()) {
      if (!partial && !this.warnedMissingKey) {
        this.warnedMissingKey = true;
        this.status(
          'no-audio',
          `已听到声音（${this.capturedSeconds.toFixed(0)} 秒）· 缺 API Key，无法识别成字幕`,
        );
      }
      return;
    }
    this.warnedMissingKey = false;

    /*
     * 时延埋点从这里开始。
     *
     * audioMs 是「这段音频本身有多长」，sttMs 是「识别它花了多久」，两者的比值
     * （实时率）才是判断字幕会不会越落越远的关键 —— 它跟网络绝对速度无关。
     * traceId 会随字幕一起发给界面，界面翻译时再带回来，这样才拼得出端到端。
     */
    const audioMs = (pcm.length / bytesForMs(1000)) * 1000;
    const traceId = beginTrace();
    const startedAt = Date.now();
    // 停止监听时要把这次请求真的掐断，而不只是「不看结果」。
    const controller = new AbortController();
    this.inflight.add(controller);
    // catch 里要知道「这次失败是不是我们自己超时掐的」——在 try 外先留一个钩子。
    let timedOut: () => boolean = () => false;

    try {
      const wav = encodeWav(pcm);
      // 上下文给足一点：识别模型会用它来消歧（人名、专业词、上句没说完的话）。
      const prompt = this.recentText.slice(-3).join(' ').slice(0, 300) || undefined;
      const deadline = withDeadline(
        getSTT({ signal: controller.signal }).transcribe({
          audio: new Uint8Array(wav),
          mimeType: 'audio/wav',
          // 必须跟着「对话语言」走：写死 en 会把俄/日/韩语音"翻译"成英文。
          language: sttLanguageCode(getSettingsStore().get().targetLanguage),
          prompt,
          signal: controller.signal,
        }),
        TRANSCRIBE_DEADLINE_MS,
        '语音识别',
        controller,
      );
      timedOut = deadline.timedOut;
      const result = await deadline.promise;
      // 请求回来时这一场可能已经结束了 —— 别把旧内容写进新字幕。
      if (this.isStale()) return;

      const sttMs = Date.now() - startedAt;
      /*
       * 识别成功 = 链路是活的 → 状态必须回到 `listening`。
       *
       * 这里以前只看 `reportedNoAudio`，于是「识别失败一次（error）」之后
       * 状态会永久停在 error，而 renderer 的看门狗只认 listening / no-audio
       * —— 整场对话的自动回复就此失效，用户只会觉得「它坏了」。
       */
      if (this.reportedNoAudio || healsAfterSuccess(this.lastStatus)) {
        this.reportedNoAudio = false;
        this.status('listening', this.listeningMessage(this.deviceName));
      }
      const text = result.text.trim();
      if (text) {
        // 耗时同时写进日志：不开界面也能从 app.log 看出慢在哪一段。
        const rtf = sttMs / Math.max(1, audioMs);
        logger.info(
          'Latency',
          `[${this.options.mode}] ${partial ? 'interim' : 'final'} audio=${Math.round(audioMs)}ms stt=${sttMs}ms rtf=${rtf.toFixed(2)} chars=${text.length}`,
        );
        recordStt({
          traceId,
          speaker: this.options.speaker,
          partial,
          audioMs,
          sttMs,
          chars: text.length,
        });
        if (!partial) {
          this.recentText.push(text);
          if (this.recentText.length > 6) this.recentText.shift();
          /*
           * 只记「多长、花了多久、几个字」，**不记句子内容**。
           *
           * 以前这里写的是 `final 3.2s -> "They said they'd..."`：app.log 就在
           * AppData 里，一场会议下来等于把整段对话抄了一份到磁盘上。用户以为
           * 「关闭软件就没了」，实际上它一直躺在那里。
           */
          logger.info(
            'Audio',
            `[${this.options.mode}] final ${(pcm.length / bytesForMs(1000)).toFixed(1)}s chars=${text.length}`,
          );
        } else {
          logger.debug(
            'Audio',
            `[${this.options.mode}] interim ${(pcm.length / bytesForMs(1000)).toFixed(1)}s chars=${text.length}`,
          );
        }
        this.emit({
          speaker: this.options.speaker,
          text,
          partial,
          confidence: partial ? Math.min(0.6, result.confidence ?? 0.5) : result.confidence,
          traceId,
        });
      } else if (!partial) {
        logger.info('Audio', `[${this.options.mode}] empty transcription`);
      }
    } catch (error) {
      /*
       * 三种「没成功」要分开说，混在一起会让用户误判：
       * - 用户主动停止 / 重启（isStale 或我们自己 abort）→ 不算失败，不打红字；
       * - 真的超时（deadline 到点，我们主动 abort 的）→ 必须报出来，否则
       *   用户看到的只是「字幕一直不出来」，完全不知道是网络还是模型；
       * - 其它错误 → 走「人话翻译」。
       */
      if (timedOut()) {
        logger.error('Audio', `[${this.options.mode}] stt deadline exceeded`);
        this.status(
          'error',
          `识别超时：${Math.round(TRANSCRIBE_DEADLINE_MS / 1000)} 秒没有返回。` +
            '这一句已放弃，下一句会继续 —— 可以到「设置 → 性能」里看是网络还是模型慢。',
        );
        // 整句真的没转写出来：字幕位置上要留一个「这里少了一句」的标记。
        if (!partial) {
          this.options.onDropped?.({ at: Date.now(), reason: '识别超时，这一句没有转写出来' });
        }
        return;
      }
      if (this.isStale() || controller.signal.aborted) {
        logger.info('Audio', `[${this.options.mode}] stt request cancelled`);
        return;
      }
      // 统一走「人话翻译」：告诉用户哪里错了 + 怎么改。
      const info = describeAiError(error);
      logger.error('Audio', `[${this.options.mode}] stt failed: ${info.code}`);
      this.status('error', `识别失败：${info.title}｜${info.hint}`);
      if (!partial) {
        this.options.onDropped?.({ at: Date.now(), reason: `这一句没有转写出来（${info.title}）` });
      }
    } finally {
      this.inflight.delete(controller);
    }
  }
}

// --------------------------------------------------------------------------- //
// Engine
// --------------------------------------------------------------------------- //

/**
 * Real engine: WASAPI loopback / microphone via the Python sidecar,
 * energy-based VAD, and segmented Whisper transcription.
 */
export class PythonAudioEngine implements AudioEngine {
  private streams: AudioStream[] = [];
  private deadStreams = 0;
  /** 「引擎死亡」只上报一次，避免双通道各报一次。 */
  private deathReported = false;

  /** 上层注入的钩子：引擎死了 / 丢了一段音频时用。 */
  onDead?: (reason: string) => void;
  onLevel?: (level: AudioLevelPayload) => void;
  onDropped?: (info: { at: number; reason: string }) => void;

  constructor(
    private readonly win: Electron.BrowserWindow,
    private readonly options: {
      sourceMode: 'online' | 'onsite';
      captureSystemAudio: boolean;
      captureMicrophone: boolean;
    } = { sourceMode: 'online', captureSystemAudio: true, captureMicrophone: false },
  ) {}

  async start() {
    const settings = getSettingsStore().get();
    // stop() 会推进会话编号 —— 上一场还在路上的识别结果从这里开始一律作废。
    this.stop();
    this.deadStreams = 0;
    this.deathReported = false;
    logger.info('Audio', `start listening (session ${activeSessionId})`);

    /*
     * 到底采哪几路、每路算「对方」还是「你」，由 resolveSources 统一算。
     *
     * 旧实现写死了「系统声音 = 对方 / 麦克风 = 你」。这在现场沟通里是反的：
     * 麦克风收到的明明是对面那个人说的话，却被当成使用者自己，于是永远
     * 不会翻译 —— 界面写着支持，功能其实不存在。
     */
    const plan = resolveSources({
      sourceMode: this.options.sourceMode,
      captureSystemAudio: this.options.captureSystemAudio,
      captureMicrophone: this.options.captureMicrophone,
    });

    for (const item of plan.items) {
      const stream = new AudioStream(this.win, {
        speaker: item.speaker,
        mode: item.channel,
        deviceId:
          (item.channel === 'loopback'
            ? settings.audio.systemDeviceId
            : settings.audio.micDeviceId) || 'default',
        onDead: (reason) => {
          this.deadStreams += 1;
          // 全部通道都死了才算引擎死亡：只挂一路时另一路还能出字幕。
          // `deathReported` 保证「引擎死亡」这件事只上报一次 —— 双通道时
          // 两路各自上报，加起来会变成 2 次事件。
          if (this.deadStreams >= this.streams.length && !this.deathReported) {
            this.deathReported = true;
            this.onDead?.(reason);
          }
        },
        onDropped: (info) => this.onDropped?.(info),
      });
      stream.start();
      this.streams.push(stream);
    }

    if (!this.streams.length) {
      if (this.win.isDestroyed()) return;
      this.win.webContents.send(IPC.AUDIO_STATUS, {
        status: 'error',
        message: plan.warning ?? '未选择任何音频来源：请在设置 → 音频里开启「系统声音」或「麦克风」',
      });
      return;
    }

    if (!hasSttKey()) {
      if (this.win.isDestroyed()) return;
      this.win.webContents.send(IPC.AUDIO_STATUS, {
        status: 'listening',
        message: '正在采集（还没有配置语音识别的 Key，暂时出不了字幕）',
      });
    }
  }

  /**
   * 等设备确认。
   *
   * 任一路成功就算就绪 —— 双路同时采集时，只要有一路能听见，字幕就能出。
   * 全部失败才报失败。
   */
  waitUntilReady(ms: number): Promise<{ ok: boolean; message: string; timedOut?: boolean }> {
    const streams = [...this.streams];
    if (!streams.length) {
      return Promise.resolve({ ok: false, message: '没有可用的音频来源' });
    }
    return new Promise((resolve) => {
      let pending = streams.length;
      let settled = false;
      const finish = (value: { ok: boolean; message: string; timedOut?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({
          ok: false,
          timedOut: true,
          message: '音频进程已经启动，但 10 秒内还没有收到设备确认。可以点「重新连接」再试一次。',
        });
      }, ms);
      for (const stream of streams) {
        void stream.whenReady(ms).then((result) => {
          if (result.ok) {
            finish(result);
            return;
          }
          pending -= 1;
          if (pending <= 0) finish(result);
        });
      }
    });
  }

  stop() {
    for (const stream of this.streams) stream.stop();
    this.streams = [];
    this.deadStreams = 0;
    /*
     * 推进会话编号。
     *
     * 这是「停止 / 重新开始后旧字幕别混进来」的核心：旧流即使在路上还有
     * 一个识别请求，回来时编号已经对不上，`emit()` 会把它丢掉。
     */
    sessionSeq += 1;
    activeSessionId = sessionSeq;
  }

  async listDevices(): Promise<{ id: string; name: string; kind: 'system' | 'mic' }[]> {
    const python = resolvePython();
    if (!python) return [];
    return new Promise((resolve) => {
      let output = '';
      let done = false;
      const finish = (value: { id: string; name: string; kind: 'system' | 'mic' }[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(python, [SCRIPT, 'devices'], { windowsHide: true });
      } catch {
        resolve([]);
        return;
      }
      /*
       * 枚举也要有超时。
       *
       * 没有它的话，python 卡在设备查询里（驱动异常、被其他程序独占）时
       * 「设置 → 音频」的设备下拉会**永远空着**，看起来像软件坏了；
       * 而用户唯一能做的就是一直等。
       */
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        logger.warn('Audio', 'device enumeration timed out');
        finish([]);
      }, 8000);
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('close', () => {
        try {
          const jsonStart = output.indexOf('[');
          finish(jsonStart >= 0 ? JSON.parse(output.slice(jsonStart)) : []);
        } catch {
          finish([]);
        }
      });
      child.on('error', () => finish([]));
    });
  }
}

/**
 * Record a couple of seconds and report the actual level.
 *
 * Used by the settings panel's 「一键诊断」 so the user can tell whether the
 * problem is capture (nothing arrives) or recognition (audio arrives but no
 * subtitles).
 */
export function probeAudio(mode: 'loopback' | 'mic', seconds = 2.5): Promise<AudioProbeResult> {
  return new Promise((resolve) => {
    const python = resolvePython();
    const failure = (message: string): AudioProbeResult => ({
      ok: false,
      mode,
      device: '',
      deviceId: '',
      rate: 0,
      channels: 0,
      rms: 0,
      peak: 0,
      db: -120,
      durationMs: Math.round(seconds * 1000),
      hasSignal: false,
      message,
    });

    if (!python) {
      resolve(
        failure(
          '安装包自带的音频组件没找到。建议重新安装本软件，或在设置 → 音频里手动指定 python.exe。',
        ),
      );
      return;
    }

    const settings = getSettingsStore().get();
    let output = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        python,
        [
          SCRIPT,
          'probe',
          '--mode',
          mode,
          '--device',
          (mode === 'loopback' ? settings.audio.systemDeviceId : settings.audio.micDeviceId) ||
            'default',
          '--seconds',
          String(seconds),
        ],
        { windowsHide: true },
      );
    } catch (error) {
      resolve(failure(String(error)));
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(failure('探测超时：音频设备没有响应，可能被其他程序独占。'));
    }, (seconds + 10) * 1000);

    child.on('close', () => {
      clearTimeout(timer);
      try {
        const start = output.indexOf('{');
        const parsed = JSON.parse(output.slice(start)) as AudioProbeResult;
        logger.info(
          'Audio',
          `probe(${mode}) device=${parsed.device} rms=${parsed.rms} hasSignal=${parsed.hasSignal}`,
        );
        resolve(parsed);
      } catch {
        resolve(failure('探测进程没有返回可解析的结果。'));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(failure(String(error)));
    });
  });
}

export function resetPythonDiscovery() {
  resolvedPython = undefined;
}
