import type { SpeakRequest, TTSProvider } from '../types';

export interface OpenAITTSConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  voice: string;
  speed: number;
  /** 取消信号：用户点停止 / 换了一句要念时，这次合成要被真的掐断。 */
  signal?: AbortSignal;
  /** 总预算（含读 body），默认 20 秒。 */
  timeoutMs?: number;
}

export async function synthesizeOpenAI(
  text: string,
  config: OpenAITTSConfig,
): Promise<ArrayBuffer> {
  if (!config.apiKey) throw new Error('MISSING_API_KEY');
  const base = config.baseURL.replace(/\/+$/, '');
  /*
   * 这里的超时是**总预算**，覆盖「发请求 + 读完 body」。
   *
   * 旧实现用的是裸 fetch：没有超时。写半截就停住的响应体会让这次合成永远挂着，
   * 而朗读是串行的 —— 一次挂住，后面的朗读全部不再出声。取消信号也接在这里，
   * 用户点停止时能立刻掐掉。
   */
  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? 20_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  if (config.signal) {
    if (config.signal.aborted) relay();
    else config.signal.addEventListener('abort', relay, { once: true });
  }

  try {
    const response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini-tts',
        input: text,
        voice: config.voice || 'alloy',
        speed: config.speed ?? 1,
        response_format: 'mp3',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`TTS_HTTP_${response.status}: ${detail.slice(0, 200)}`);
    }
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
    config.signal?.removeEventListener('abort', relay);
  }
}

/**
 * Renderer-side player: the audio bytes are produced in the main process
 * (where the API key lives) and returned as base64.
 *
 * 这里有两个必须靠「代次号」解决的问题，都是用户能直接感知到的：
 * 1. **迟到的合成**。点「慢速播放」时，云端合成要几百毫秒到几秒。如果这期间
 *    用户换了另一张卡、或者点了停止，合成回来的旧音频**仍然会自己响起来**。
 *    现在 `speak` 记住自己那一代，回来发现代次变了就直接丢弃。
 * 2. **停止后 promise 永远不 resolve**。旧 `stop()` 只是 pause + 置空，播放
 *    中的那个 Promise 既不会 onended 也不会 onerror，于是调用方一直挂在
 *    `await` 上。现在 stop() 会主动把 resolver 叫醒。
 */
export class OpenAITTS implements TTSProvider {
  readonly id = 'openai-tts';
  readonly displayName = 'OpenAI TTS';

  private audio: HTMLAudioElement | null = null;
  /** 每调用一次 speak/stop 就 +1；合成回来时对不上就作废。 */
  private generation = 0;
  /** 当前这次播放的 resolver，stop() 要能把它叫醒。 */
  private pendingResolve: (() => void) | null = null;

  constructor(
    private readonly request: (
      text: string,
      speed?: number,
      requestId?: string,
    ) => Promise<string>,
    /** 取消一次在途合成（主进程真的 abort，而不是等它跑完再丢结果）。 */
    private readonly cancel?: (requestId: string) => void,
  ) {}

  async speak(request: SpeakRequest): Promise<void> {
    const gen = (this.generation += 1);
    // 先把上一条掐掉，再开始合成 —— 否则会有两条同时在响。
    this.stopPlayback();
    // 上一条还在合成的话，让它立刻停下，别白烧额度。
    this.cancel?.(`tts:${gen - 1}`);

    const speed = request.speed ?? 1;
    const requestId = `tts:${gen}`;
    const base64 = await this.request(request.text, speed, requestId);

    // 合成期间用户可能已经点了停止 / 播了另一句：这一条已经过期了。
    if (gen !== this.generation) return;
    if (!base64) throw new Error('TTS_EMPTY');

    // CSP 必须放行 data: 才能播（见 src/renderer/index.html 的 media-src）。
    const audio = new Audio(`data:audio/mp3;base64,${base64}`);
    this.audio = audio;

    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.pendingResolve === resolve) this.pendingResolve = null;
        if (this.audio === audio) this.audio = null;
        resolve();
      };
      this.pendingResolve = resolve;
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  }

  stop() {
    // 代次号一变，正在合成的那一条回来时就会被丢掉。
    // 同时通知主进程 abort —— 只是「回来时丢掉」会白烧一次合成额度。
    this.cancel?.(`tts:${this.generation}`);
    this.generation += 1;
    this.stopPlayback();
  }

  private stopPlayback() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio = null;
    }
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.();
  }
}
