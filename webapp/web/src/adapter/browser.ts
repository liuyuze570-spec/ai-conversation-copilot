/**
 * 浏览器适配层。
 *
 * 桌面版所有能力都走 `window.copilot`（Electron IPC）。网页里**没有**这个对象，
 * 所以每个能力都要单独检测、单独降级：
 *
 * - 麦克风：需要 `navigator.mediaDevices` + **安全上下文（https 或 localhost）**；
 *   普通 http 打开时浏览器直接不给 `mediaDevices`，不能靠 try/catch 补救。
 * - 录音格式：Chrome/Edge 出 `audio/webm;codecs=opus`，Safari 出 `audio/mp4`。
 *   后端必须两种都能解，前端只负责如实上报实际选的格式。
 * - 朗读：`speechSynthesis` 有声音不等于有**对应语言**的声音，必须按 lang 过滤。
 *
 * 这一层不做任何「假装能用」的处理：拿不到就返回具体原因，由界面显示。
 */

export type MicSupport = 'ok' | 'insecure' | 'unsupported';

export interface Capabilities {
  secure: boolean;
  mic: MicSupport;
  recorderMime: string | null;
  fileUpload: boolean;
  speech: { available: boolean; voices: string[] };
}

function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export function detectCapabilities(): Capabilities {
  const secure = typeof window !== 'undefined' ? window.isSecureContext : false;
  const hasMedia = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const mic: MicSupport = !hasMedia ? (secure ? 'unsupported' : 'insecure') : 'ok';
  const voices =
    typeof speechSynthesis !== 'undefined'
      ? speechSynthesis.getVoices().map((voice) => voice.lang)
      : [];
  return {
    secure,
    mic,
    recorderMime: pickMime(),
    fileUpload: typeof File !== 'undefined' && typeof FormData !== 'undefined',
    speech: { available: typeof speechSynthesis !== 'undefined', voices },
  };
}

export type MicErrorCode =
  | 'permission-denied'
  | 'no-device'
  | 'in-use'
  | 'insecure'
  | 'unsupported'
  | 'unknown';

export interface MicError {
  code: MicErrorCode;
  message: string;
}

export function describeMicError(error: unknown): MicError {
  const name = error && typeof error === 'object' ? (error as { name?: string }).name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: 'permission-denied',
        message: '浏览器拒绝了麦克风权限。可以用下面的文字输入或音频文件，功能不受影响。',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { code: 'no-device', message: '这台设备上没找到麦克风。可以改用文字输入或音频文件。' };
    case 'NotReadableError':
    case 'AbortError':
      return { code: 'in-use', message: '麦克风被别的程序占用了，关掉那个程序再试。' };
    default:
      return { code: 'unknown', message: '麦克风打开失败，可以改用文字输入或音频文件。' };
  }
}

export interface RecorderHandle {
  stop: () => Promise<Blob>;
  cancel: () => void;
  mime: string;
}

/** 录音器：停止时一定释放麦克风（轨道 stop），取消时不产出音频。 */
export async function startRecording(onEnded?: () => void): Promise<RecorderHandle> {
  if (!window.isSecureContext) {
    throw Object.assign(new Error('insecure'), { name: 'SecurityError' });
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    video: false,
  });
  const mime = pickMime();
  if (mime === null) {
    stream.getTracks().forEach((track) => track.stop());
    throw Object.assign(new Error('no-recorder'), { name: 'NotSupportedError' });
  }
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  let cancelled = false;
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener('stop', () => {
    stream.getTracks().forEach((track) => track.stop());
    onEnded?.();
  });
  recorder.start(1000);

  const finish = (): Promise<Blob> =>
    new Promise((resolve, reject) => {
      if (recorder.state === 'inactive') {
        reject(Object.assign(new Error('inactive'), { name: 'InvalidStateError' }));
        return;
      }
      recorder.addEventListener(
        'stop',
        () => {
          if (cancelled) {
            resolve(new Blob([], { type: recorder.mimeType || 'audio/webm' }));
            return;
          }
          resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        },
        { once: true },
      );
      recorder.stop();
    });

  return {
    mime: recorder.mimeType || mime || 'audio/webm',
    stop: finish,
    cancel: () => {
      cancelled = true;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } finally {
        stream.getTracks().forEach((track) => track.stop());
      }
    },
  };
}

/** 系统里有没有能和这个语言对上的声音（不是「有没有 speechSynthesis」）。 */
export function hasVoiceFor(language: string): boolean {
  if (typeof speechSynthesis === 'undefined') return false;
  const target = language.toLowerCase().split('-')[0];
  return speechSynthesis.getVoices().some((voice) => voice.lang.toLowerCase().startsWith(target));
}

export function speak(text: string, language: string): { ok: boolean; reason?: string } {
  if (typeof speechSynthesis === 'undefined') return { ok: false, reason: '这个浏览器不支持朗读' };
  if (!hasVoiceFor(language)) {
    return { ok: false, reason: `这台设备没有 ${language} 的语音，装了语音包才能读` };
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = language;
  speechSynthesis.speak(utterance);
  return { ok: true };
}
