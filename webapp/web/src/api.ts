/**
 * 与 Python 后端（webapp/server）的唯一接口层。
 *
 * 纪律：
 * 1. 前端**不含任何 Key**，也不接受任意上游地址 —— 地址固定在后端环境里。
 * 2. 每次请求都带 request_id，界面显示的是后端真的返回了什么，不是本地拼的。
 * 3. `mode` 必须原样透传到界面：`argos` / `local-whisper` 是真跑模型，
 *    `provider` 是真调云端，`mock` 是预置结果 —— 三者不许混着展示。
 */

export type TranslateMode = 'local-onnx' | 'local-opus' | 'argos' | 'provider' | 'mock';
export type TranscribeMode = 'local-whisper' | 'provider' | 'mock';

export interface HealthLimits {
  max_chars: number;
  max_audio_mb: number;
  max_audio_seconds: number;
  quota_translate: number;
  quota_transcribe: number;
}

export interface Health {
  ok: boolean;
  version: string;
  mode: { translate: TranslateMode; transcribe: TranscribeMode; reply: TranslateMode };
  limits: HealthLimits;
  /** 是否具备真实能力（至少一路不是 mock）。界面据此显示「真实」还是「预置」。 */
  real: { translate: boolean; transcribe: boolean; reply: boolean };
  notes: string[];
}

export interface TranslateResult {
  request_id: string;
  translation: string;
  mode: TranslateMode;
  source_language: string;
  target_language: string;
  elapsed_ms: number;
}

export interface TranscribeResult {
  request_id: string;
  text: string;
  mode: TranscribeMode;
  language: string;
  elapsed_ms: number;
  duration_seconds: number | null;
}

export interface ReplyResult {
  request_id: string;
  reply: string;
  meaning: string;
  mode: TranslateMode;
  elapsed_ms: number;
}

export class ApiError extends Error {
  code: string;
  status: number;
  requestId: string | null;

  constructor(code: string, message: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

function url(path: string): string {
  return `${base}${path}`;
}

async function fail(response: Response): Promise<never> {
  let code = `HTTP_${response.status}`;
  let message = '请求失败';
  let requestId: string | null = response.headers.get('x-request-id');
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
      request_id?: string;
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    if (body.request_id) requestId = body.request_id;
  } catch {
    // 服务端没返回 JSON（网关层错误），保留 HTTP 码即可。
  }
  throw new ApiError(code, message, response.status, requestId);
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) await fail(response);
  return (await response.json()) as T;
}

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch(url('/api/health'), {
    method: 'GET',
    credentials: 'same-origin',
    signal,
  });
  return json<Health>(response);
}

export async function createSession(signal?: AbortSignal): Promise<{ session_id: string; ttl_seconds: number }> {
  const response = await fetch(url('/api/session'), {
    method: 'POST',
    credentials: 'same-origin',
    signal,
  });
  return json<{ session_id: string; ttl_seconds: number }>(response);
}

export async function translate(
  text: string,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  const response = await fetch(url('/api/translate'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, source_language: 'en', target_language: 'zh' }),
    signal,
  });
  return json<TranslateResult>(response);
}

export async function transcribe(
  blob: Blob,
  filename: string,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append('audio', blob, filename);
  form.append('language', 'en');
  const response = await fetch(url('/api/transcribe'), {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
    signal,
  });
  return json<TranscribeResult>(response);
}

export async function reply(
  text: string,
  translation: string,
  signal?: AbortSignal,
): Promise<ReplyResult> {
  const response = await fetch(url('/api/reply'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, translation, target_language: 'en' }),
    signal,
  });
  return json<ReplyResult>(response);
}

export function modeLabel(mode: TranslateMode | TranscribeMode): string {
  switch (mode) {
    case 'local-onnx':
    case 'local-opus':
    case 'argos':
      return '本地翻译模型（真实翻译）';
    case 'provider':
      return '云端模型（真实调用）';
    case 'local-whisper':
      return '本地语音识别（真实识别）';
    default:
      return '预置演示结果（不是真实模型输出）';
  }
}
