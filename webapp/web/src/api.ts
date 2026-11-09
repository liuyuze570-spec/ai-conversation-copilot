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
  /** 是否**配置了**真实能力（至少一路不是 mock）。配置了不等于调通了。 */
  real: { translate: boolean; transcribe: boolean; reply: boolean };
  /**
   * 是否真的成功返回过至少一次。
   * 配了一个错 Key 时 `real` 仍是 true，只有这里会是 false —— 界面要分开显示。
   */
  verified?: { translate: boolean; transcribe: boolean; reply: boolean };
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
  /** 服务端明确说「这个问题可以安全重建会话后重试」。目前只有 SESSION_REQUIRED。 */
  recoverable: boolean;

  constructor(code: string, message: string, status: number, requestId: string | null, recoverable = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.recoverable = recoverable;
  }
}

const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

function url(path: string): string {
  return `${base}${path}`;
}

// --------------------------------------------------------------------------- //
// 匿名会话
//
// 2026-11-09 公网实测的问题：访客第一次提交真实翻译就提示「会话过期」，刷新再来
// 还是同样结果。会话本身是好的（同一条链接、同一份代码，命令行建完会话立刻翻译
// 8/8 成功），所以问题在「浏览器这一侧有没有把会话带回来」以及「带回来的是不是
// 被本进程认识」。
//
// 对策不是关掉鉴权，而是：
// 1. 会话标识同时走两条路 —— HttpOnly Cookie（主）和 `X-Session-Id` 请求头（备），
//    任一条通就能用；后端两种都查同一张会话表，没有放宽任何校验。
// 2. 失去会话时，**保留用户输入**，重建一次并重试一次；会话检查在扣配额和跑模型
//    之前，所以这次重试不会重复扣费，也不会绕过配额（新会话仍有同样的上限）。
// 3. 只重试一次。再失败就如实报错并给重试入口，不做循环。
// --------------------------------------------------------------------------- //

const SESSION_KEY = 'copilot.session.token.v1';
let sessionToken: string | null = readStoredToken();

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_KEY);
  } catch {
    // 隐私模式/禁用存储时直接放弃，内存里那份仍然可用。
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(SESSION_KEY, token);
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* 存不了就算了 */
  }
}

export function currentSessionToken(): string | null {
  return sessionToken;
}

function sessionHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (sessionToken) headers['x-session-id'] = sessionToken;
  return headers;
}

export interface SessionInfo {
  session_id: string;
  token: string;
  ttl_seconds: number;
  quota?: { translate: number; transcribe: number; reply: number };
}

export async function createSession(signal?: AbortSignal): Promise<SessionInfo> {
  const response = await fetch(url('/api/session'), {
    method: 'POST',
    credentials: 'same-origin',
    signal,
  });
  const info = await json<SessionInfo>(response);
  if (info.token) {
    sessionToken = info.token;
    writeStoredToken(info.token);
  }
  return info;
}

/** 确保手上有一个服务端认识的会话；`force` 用于已知失效后重建。 */
export async function ensureSession(force = false, signal?: AbortSignal): Promise<SessionInfo> {
  if (!force && sessionToken) {
    return { session_id: sessionToken.slice(0, 8), token: sessionToken, ttl_seconds: 0 };
  }
  return createSession(signal);
}

async function fail(response: Response): Promise<never> {
  let code = `HTTP_${response.status}`;
  let message = '请求失败';
  let requestId: string | null = response.headers.get('x-request-id');
  let recoverable = false;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; recoverable?: boolean };
      request_id?: string;
    };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
    if (body.error?.recoverable) recoverable = true;
    if (body.request_id) requestId = body.request_id;
  } catch {
    // 服务端没返回 JSON（网关层错误），保留 HTTP 码即可。
  }
  throw new ApiError(code, message, response.status, requestId, recoverable);
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

export async function translate(
  text: string,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  const response = await fetch(url('/api/translate'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: sessionHeaders({ 'content-type': 'application/json' }),
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
    headers: sessionHeaders(),
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
    headers: sessionHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text, translation, target_language: 'en' }),
    signal,
  });
  return json<ReplyResult>(response);
}

/**
 * 带会话执行一次真实调用。
 *
 * 顺序是固定的：先确保有会话，再发请求；只有 `SESSION_REQUIRED`（服务端标注
 * `recoverable`）才会重建会话并**重试一次**。其它错误原样抛出，绝不悄悄重发 ——
 * 重发等于让用户为同一句话付两次额度。
 */
export async function withSession<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await ensureSession(false, signal);
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'SESSION_REQUIRED' && error.recoverable) {
      await ensureSession(true, signal);
      return await run();
    }
    throw error;
  }
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
