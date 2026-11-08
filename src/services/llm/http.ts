/**
 * 带「总超时 + 分级重试 + 可取消」的 HTTP 封装。
 *
 * 旧实现有三个真问题，都是实测出来的：
 * 1. **超时只管到响应头**。`fetch()` resolve 之后 `finally` 就把定时器清了，
 *    所以「服务商回了 200、body 却再也不来」的情况会永久挂住 —— 字幕和回复
 *    就永远停在「思考中」。现在超时是一个**总预算**，连着读 body 一起算。
 * 2. **重试各自计时**。每次重试都拿一份全新的 timeout，45 秒 × 3 次 = 最坏
 *    135 秒，用户早就以为软件死了。现在总预算从发第一个请求时开始算。
 * 3. **什么错都重试**。Key 填错了（401）、余额不足（402）、模型名打错（404）
 *    重试一百次结果也一样，只是让用户多等十几秒。现在只有「服务端忙 / 限流 /
 *    超时 / 网络抖动」才重试，鉴权类错误立刻原样抛给用户。
 */

export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`HTTP_${status}: ${detail.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

export interface RequestOptions {
  /**
   * **总**超时预算（毫秒）：从第一个请求发出，到最后一个响应体读完。
   * 重试与读 body 都算在这份预算里，用户最多等这么久。
   */
  timeoutMs?: number;
  /** 失败后额外重试的次数（总请求数 = retries + 1）。 */
  retries?: number;
  /** 外部取消信号（用户点了停止监听 / 关闭回复）。 */
  signal?: AbortSignal;
  /** 每次准备重试时回调，方便打日志 / 更新界面。 */
  onRetry?: (info: { attempt: number; status?: number; reason: string }) => void;
}

/** 这些状态码值得重试：服务端忙、限流、超时、网关抖动。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * 这些状态码重试没有任何意义，必须让用户立刻看到真正的原因：
 * 401/403 = Key 不对或没权限，402 = 没钱，400/404/422 = 参数或模型名错。
 * 它们不在 RETRYABLE_STATUS 里，因此本来就不会重试 —— 这里额外提供判定函数，
 * 让调用方能据此给出更准的提示（例如「别再点了，去换 Key」）。
 */
export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403;
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TextResponse {
  ok: boolean;
  status: number;
  /** 响应体原文（已完整读出，受总预算保护）。 */
  text: string;
}

/**
 * 发请求并**读完整个响应体**，全程受一份总预算约束。
 *
 * 返回而不抛错的只有一种情况：HTTP 状态码不是 2xx 且不值得重试（例如 401）。
 * 调用方拿 `ok === false` + `text` 去组装给人看的错误。
 */
export async function requestText(
  url: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<TextResponse> {
  const { timeoutMs = 30_000, retries = 2, signal, onRetry } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error = new Error('NETWORK_ERROR');

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new Error('ABORT');

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // 预算已经花完 —— 与其再等一次，不如如实告诉用户「太慢了」。
      throw lastError.message === 'NETWORK_ERROR' ? new Error('HTTP_TIMEOUT') : lastError;
    }

    const controller = new AbortController();
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remaining);
    const onAbort = () => {
      aborted = true;
      controller.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      // 关键：在 finally 之前把 body 读完，超时才盖得住「body 迟迟不来」。
      const text = await response.text();

      if (!response.ok && isRetryableStatus(response.status) && attempt < retries) {
        lastError = new HttpError(response.status, text);
        onRetry?.({
          attempt: attempt + 1,
          status: response.status,
          reason: `HTTP ${response.status}`,
        });
        await sleep(backoffMs(attempt));
        continue;
      }

      return { ok: response.ok, status: response.status, text };
    } catch (error) {
      if (aborted) throw new Error('ABORT');
      if (timedOut) {
        lastError = new Error('HTTP_TIMEOUT');
        if (attempt < retries) {
          onRetry?.({ attempt: attempt + 1, reason: 'timeout' });
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }
      lastError = new Error(`NETWORK_ERROR: ${String(error)}`);
      if (attempt < retries) {
        onRetry?.({ attempt: attempt + 1, reason: 'network' });
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError;
}

/**
 * 发请求并解析 JSON。
 *
 * `data` 为 `null` 表示「body 不是合法 JSON」—— 这在中转网关回复 HTML 错误页时
 * 很常见，调用方要能用 `text` 说清楚到底收到了什么，而不是抛一个看不懂的
 * `Unexpected token <`。
 */
export async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const result = await requestText(url, init, options);
  let data: T | null = null;
  if (result.text) {
    try {
      data = JSON.parse(result.text) as T;
    } catch {
      data = null;
    }
  }
  return { ...result, data };
}

/** 指数退避 + 随机抖动，避免同一秒内所有重试一起打过去。 */
function backoffMs(attempt: number): number {
  const base = 400 * 2 ** attempt;
  const jitter = Math.random() * 200;
  return Math.min(base + jitter, 4000);
}

/**
 * 从响应体原文里读出服务商自己写的错误说明。
 *
 * 国内网关的格式五花八门：`{"error":{"message":...}}`、`{"message":...}`、
 * 纯文本、甚至一段 HTML。都试一遍，拿不到就返回原文（截断在调用方做）。
 */
export function errorDetailFromText(text: string): string {
  const raw = (text || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
      msg?: string;
      detail?: string;
    };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
    if (parsed.msg) return parsed.msg;
    if (parsed.detail) return parsed.detail;
  } catch {
    /* 不是 JSON（多半是网关的 HTML 错误页），直接用原文 */
  }
  return raw;
}
