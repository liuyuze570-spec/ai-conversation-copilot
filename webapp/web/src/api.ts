/**
 * 与 Python 后端（webapp/server）的唯一接口层。
 *
 * 纪律：
 * 1. 前端**不含任何 Key**，也不接受任意上游地址 —— 地址固定在后端环境里。
 * 2. 每次请求都带 request_id，界面显示的是后端真的返回了什么，不是本地拼的。
 * 3. `mode` 必须原样透传到界面：`argos` / `local-whisper` 是真跑模型，
 *    `provider` 是真调云端，`mock` 是预置结果 —— 三者不许混着展示。
 */

export type TranslateMode = 'phrasebook' | 'local-onnx' | 'local-opus' | 'local-cascade' | 'argos' | 'provider' | 'mock';
export type TranscribeMode = 'local-whisper' | 'provider' | 'mock';

/** 「对方说的是哪种语言」。中文永远在译文那一侧。 */
export type SourceLanguage = 'en' | 'ja' | 'ko' | 'ru';

export const SOURCE_LANGUAGES: { code: SourceLanguage; label: string; sample: string }[] = [
  { code: 'en', label: '英语', sample: 'Hello, how are you?' },
  { code: 'ja', label: '日语', sample: 'こんにちは、お元気ですか。' },
  { code: 'ko', label: '韩语', sample: '안녕하세요, 잘 지내세요?' },
  { code: 'ru', label: '俄语', sample: 'Здравствуйте, как дела?' },
];

/** 一种源语言的可用状态。`ready=false` 时界面必须禁用，不能让人点了才发现不行。 */
export interface LanguageState {
  ready: boolean;
  pipeline: string | null;
  label: string;
}

export interface HealthLimits {
  max_chars: number;
  max_audio_mb: number;
  max_audio_seconds: number;
  quota_translate: number;
  quota_transcribe: number;
  /** P2 持续字幕：音频秒数预算 / 单片上限 / 识别并发 / 每分钟频率。 */
  audio_budget_seconds?: number;
  segment_max_seconds?: number;
  asr_concurrency?: number;
  rate_per_min?: number;
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
  /**
   * 源语言支持情况。由服务端读本机模型目录得出，不是写死的清单 ——
   * 没装模型的语种这里会是 ready:false，界面据此禁用。
   */
  languages?: {
    source: Partial<Record<SourceLanguage, LanguageState>>;
    target: string[];
  };
  notes: string[];
}

export interface TranslateResult {
  request_id: string;
  translation: string;
  mode: TranslateMode;
  /** 常用语库命中时区分「整句」还是「单词词义」。 */
  note?: 'sentence' | 'word';
  /** 命中来自拼写变体（hellow → hello）。 */
  corrected?: boolean;
  /** 命中的归一化写法，用来告诉使用者「按哪个词查的」。 */
  matched?: string;
  /** 这一路被判退化而跳过的原因（只含模式 + 原因码，不含正文）。 */
  skipped?: string[];
  /**
   * 服务端对译文做的修正（只在原话没有相应信息时发生）：
   * `currency-removed` = 模型补了原话没有的币种，已删；
   * `reschedule-restored` = 原话说了「改」，译文漏了，已补成「由…改到…」。
   */
  corrections?: string[];
  /** 日/韩/俄两级转译时，中间那句英语。 */
  via?: string | null;
  /** 实际走的翻译路径，例如 `ja-en-zh`。 */
  pipeline?: string;
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
  /** 持续字幕：片段顺序号与剩余音频秒数预算。 */
  seq?: number;
  audio_budget_left_seconds?: number | null;
}

export interface ReplySuggestion {
  reply: string;
  meaning: string;
  /** confirm = 复述确认；repeat = 请对方打字/重复；ask = 稍后回复；thanks = 中性回应。 */
  kind: string;
}

export interface ReplyResult {
  request_id: string;
  reply: string;
  meaning: string;
  mode: TranslateMode;
  suggestions?: ReplySuggestion[];
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
  sourceLanguage: SourceLanguage = 'en',
): Promise<TranslateResult> {
  const response = await fetch(url('/api/translate'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: sessionHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text, source_language: sourceLanguage, target_language: 'zh' }),
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

/**
 * 持续字幕的短切片识别。与 `transcribe()` 的区别是显式 `segment=1` + 顺序号：
 * 服务端按音频秒数预算计费、限制并发，日志能按 seq 排查积压，
 * 但**不会**为每个片段生成回复建议（回复由使用者选中某句后再生成）。
 */
export async function transcribeSegment(
  wav: Blob,
  seq: number,
  signal?: AbortSignal,
  language: string = 'en',
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append('audio', wav, `segment-${seq}.wav`);
  form.append('language', language);
  form.append('segment', '1');
  form.append('seq', String(seq));
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
    case 'phrasebook':
      return '常用语库（人工整理）';
    case 'local-onnx':
    case 'local-opus':
    case 'argos':
      return '本地翻译模型（真实翻译）';
    case 'local-cascade':
      return '本地翻译模型（经英语转译）';
    case 'provider':
      return '云端模型（真实调用）';
    case 'local-whisper':
      return '本地语音识别（真实识别）';
    default:
      return '预置演示结果（不是真实模型输出）';
  }
}

// --------------------------------------------------------------------------- //
// 反馈：真入库 + 匿名凭证查询
//
// 字数上限不写死在前端：从 /api/feedback/config 取，前后端同一份规则。
// 提交失败时异常原样抛给界面，界面**不清空输入框**（用户写的内容不能丢）。
// --------------------------------------------------------------------------- //

export interface FeedbackConfig {
  max_chars: number;
  count_rule: string;
  counted_fields: string[];
  categories: { value: string; label: string }[];
  statuses: { value: string; label: string }[];
  attach_default: boolean;
  storage: string;
  note: string;
}

export interface FeedbackPayload {
  where_wrong: string;
  suggestion: string;
  category: string;
  original: string;
  translation: string;
  reply_text: string;
  diagnostics: string;
  attach_context: boolean;
}

export interface FeedbackReceipt {
  ok: boolean;
  ticket: string;
  token: string;
  status: string;
  status_label: string;
  chars: number;
  max_chars: number;
  fixed_version: string;
}

export interface FeedbackRecord {
  ok: boolean;
  ticket: string;
  status: string;
  status_label: string;
  fixed_version: string;
  created_at: number;
  where_wrong: string;
  suggestion: string;
  category: string;
  category_label: string;
  original: string;
  translation: string;
  reply_text: string;
  diagnostics: string;
  attach_context: boolean;
}

export async function getFeedbackConfig(signal?: AbortSignal): Promise<FeedbackConfig> {
  const response = await fetch(url('/api/feedback/config'), {
    method: 'GET',
    credentials: 'same-origin',
    signal,
  });
  return json<FeedbackConfig>(response);
}

export async function submitFeedback(
  payload: FeedbackPayload,
  signal?: AbortSignal,
): Promise<FeedbackReceipt> {
  const response = await fetch(url('/api/feedback'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: sessionHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
    signal,
  });
  return json<FeedbackReceipt>(response);
}

export async function queryFeedback(
  ticket: string,
  token: string,
  signal?: AbortSignal,
): Promise<FeedbackRecord> {
  // 查询凭证走请求头，不拼进 URL：URL 会进浏览器历史、反向代理与 access_log，
  // 把一次性凭证写进这些地方等于泄露。后端仍保留 ?token= 旧方式做短期兼容，
  // 但这里不再使用（该方式已废弃，见 deploy/README.md）。
  const response = await fetch(url(`/api/feedback/${encodeURIComponent(ticket)}`), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { 'x-feedback-token': token },
    signal,
  });
  return json<FeedbackRecord>(response);
}
