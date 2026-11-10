import type { LLMProvider, ReplyDraft, ReplyRequest } from '../types';
import { buildReplyMessages } from './prompts';
import { enrichDrafts } from '../pronunciation';
import { errorDetailFromText, requestJson, type RequestOptions } from './http';
import { parseReplyDrafts, dropWrongLanguageDrafts } from './reply-parse';
import { checkDomesticURL, normalizeBaseURL } from '../../shared/providers';
import { checkTranslationFidelity } from '../../shared/facts';

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Extra headers, used by Azure / custom gateways. */
  headers?: Record<string, string>;
  /** **总**超时预算，默认 45 秒（含重试与读响应体）。 */
  timeoutMs?: number;
  /** 失败自动重试次数。 */
  retries?: number;
  /** 重试回调，用于打日志。 */
  onRetry?: RequestOptions['onRetry'];
  /**
   * 外部取消信号。
   *
   * 没有它的时候，「点停止监听 / 关闭回复面板」只是**不再看**结果，底层请求
   * 还在跑、还在烧额度；重启监听后旧请求回来还可能把新字幕的画面撬走。
   */
  signal?: AbortSignal;
}

/**
 * 修复「值没加引号」这种最常见的坏 JSON。
 *
 * 免费小模型（Qwen2.5-7B / Qwen3-8B 等）经常写出
 *     "ipa": tʰatz ˈɹaʊf
 * 这种没有双引号的字符串值（音标、带特殊符号的文本尤其容易），
 * 一解析就整个回复报错。这里按行把已知字段的裸值补上引号。
 * 没加引号的数组 / 对象 / 数字 / 布尔值都不会被误伤。
 */
function repairUnquotedStrings(text: string): string {
  const keys =
    'english|chinese|meaning|ipa|chinesePronunciation|readingHint|romanization|kind|replies';
  const pattern = new RegExp(
    `("(?:${keys})"\\s*:\\s*)(?!\\s*["\\[{]|\\s*(?:true|false|null)\\b|\\s*-?\\d)([^\\n\\r]*?)(\\s*[,\\n\\r}]|$)`,
    'g',
  );
  return text.replace(pattern, (_full, head: string, value: string, tail: string) => {
    const cleaned = String(value).trim().replace(/["]+$/, '').trim();
    return `${head}${JSON.stringify(cleaned)}${tail}`;
  });
}

/**
 * 从一次模型回复里把 JSON 抠出来。
 *
 * 需要处理的三种脏数据：
 * 1. 推理型模型（Qwen3 等）在正文前先吐一段  thinking...（里面也带花括号）；
 * 2. 外面裹一层 ```json 代码块；
 * 3. 字符串值忘了加双引号（见 repairUnquotedStrings）。
 */
export function extractJson(raw: string): unknown {
  let text = raw.trim();
  text = text
    .replace(/<\s*(think|thinking|reasoning|analysis)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const candidates: string[] = [];
  // 优先定位真正的结果对象（我们只要 {"replies":[...]}）。
  const repliesAt = /{\s*"replies"/.exec(text);
  if (repliesAt) {
    const sliced = text.slice(repliesAt.index);
    const end = sliced.lastIndexOf('}');
    if (end > 0) candidates.push(sliced.slice(0, end + 1));
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(text);

  let lastError: unknown = null;
  for (const candidate of candidates) {
    for (const attempt of [candidate, repairUnquotedStrings(candidate)]) {
      try {
        return JSON.parse(attempt);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 推理型模型的「思考」开关。
 *
 * 实时字幕/口语对话场景里，模型先想 5–10 秒再回答是致命的（日志里实测一次
 * 回复要 10 秒），而且思考文本会污染 JSON 输出。这些模型都支持显式关闭。
 * 只对明确认识的型号加这个字段——乱给别的服务商塞未知参数可能直接被 400。
 */
function thinkingSwitch(model: string): Record<string, unknown> {
  if (/qwen3|qwq|glm-z1|hunyuan-t1/i.test(model)) {
    return { enable_thinking: false };
  }
  return {};
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAICompatibleLLM implements LLMProvider {
  readonly id = 'openai-compatible';
  readonly displayName = 'OpenAI Compatible LLM';

  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = config;
  }

  updateConfig(config: Partial<OpenAICompatibleConfig>) {
    this.config = { ...this.config, ...config };
  }

  private get baseURL(): string {
    return normalizeBaseURL(this.config.baseURL);
  }

  private get endpoint(): string {
    return `${this.baseURL}/chat/completions`;
  }

  async complete(prompt: string): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }], 0.3);
  }

  async generateReplies(request: ReplyRequest, options: { signal?: AbortSignal } = {}): Promise<ReplyDraft[]> {
    const messages = buildReplyMessages(request);
    const hasThinking = Object.keys(thinkingSwitch(this.config.model)).length > 0;

    /*
     * 按「效果最好 → 最保守」的顺序试，但**先保延迟、再保格式**：
     *
     * 1. JSON 模式 + 关掉思考（最理想）；
     * 2. 放弃 JSON 模式，仍然关掉思考 —— 国内网关对 response_format 的支持
     *    参差不齐，反而是这个字段最容易 400；一旦退回 3 就变成「开着思考」
     *    跑，实测一次回复要 10–20 秒，实时场景完全不能用；
     * 3. 连思考开关也不认，那就只能用网关默认行为（提示词里仍然要求只返回
     *    JSON，脏数据再交给 extractJson 修）。
     */
    const modes: { json?: boolean; plain?: boolean }[] = [
      { json: true },
      {},
      ...(hasThinking ? [{ plain: true }] : []),
    ];

    let raw = '';
    let lastError: unknown = null;
    for (const mode of modes) {
      try {
        raw = await this.chat(messages, 0.8, mode, options.signal);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        // 只有「格式/参数不被接受」才值得降级再试一次。
        // 401（Key 错）、402（没钱）、403（没权限）换一种请求体也是同样的结果，
        // 再发两次只会让用户多等十几秒、还多烧两次额度 —— 直接抛出去。
        if (!isDowngradableHttpError(message)) throw error;
      }
    }
    if (lastError) throw lastError;

    const parsed = extractJson(raw);
    // 结构校验全部交给 parseReplyDrafts：它会把「replies 不是数组」「chinese 是数字」
    // 「kind 是瞎写的」这些脏数据收敛掉，而不是让它们一路崩到界面上。
    const drafts = parseReplyDrafts(parsed, 3);
    if (!drafts.length) throw new Error('LLM_EMPTY_RESPONSE');

    /*
     * 目标语言闸门（忠实转译的关键）：模型可能把「转成外语」理解成「用中文解释」，
     * 于是 english 字段整个是中文 —— 那正是「更多→中文转外语」三卡里的第二条。
     * 结构校验查不出这种错误（它只是字符串），这里按字系把串了语言的卡整条丢掉，
     * 宁可少一张卡，也不能让用户照着中文念给对面听。
     */
    const language = request.language ?? 'English';
    const { kept, dropped } = dropWrongLanguageDrafts(drafts, language);
    if (!kept.length) {
      // 全被语言闸门拦下：说明这次输出整体语言错了，报一个明确错误让上层重试，
      // 而不是把一堆错误语言的卡当成可用结果。
      throw new Error('LLM_WRONG_LANGUAGE');
    }
    if (dropped > 0) {
      // 部分卡语言串了：静默丢弃，界面少一张卡总好过一张错语言卡。
      // （不在这里打日志，避免把模型返回的正文写进日志。）
    }

    /*
     * 忠实转译的第二道闸：金额 / 币种 / 星期 / 数字保真。
     *
     * 语言字系过滤只保证「英文卡里没有中文」，保证不了「英文卡里的金额、
     * 日期和用户原话一致」。用户输入「不是540欧元、周五」时，模型可能把
     * 540 写成肯定金额、把周五写成 Thursday —— 这些字系都对、事实却错了。
     * 这里拿用户原话逐条核对，不忠实的卡整条丢掉。
     */
    let faithful = kept;
    if (request.mode === 'from-chinese' && request.chinese?.trim()) {
      faithful = kept.filter(
        (draft) => checkTranslationFidelity(request.chinese ?? '', draft.english).ok,
      );
      if (!faithful.length) {
        throw new Error('LLM_UNFAITHFUL');
      }
    }

    // 提示体系跟着设置走：日语读者要片假名，别给他汉字近音。
    return enrichDrafts(
      faithful,
      request.language ?? 'English',
      request.hintSystem ?? 'hanzi',
    );
  }

  async chat(
    messages: ChatMessage[],
    temperature: number,
    options: { json?: boolean; plain?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error('MISSING_API_KEY');
    }
    if (!this.config.model) {
      throw new Error('MISSING_MODEL');
    }

    // 硬性合规：除了本地地址，只允许国内接口。
    const urlCheck = checkDomesticURL(this.config.baseURL);
    if (!urlCheck.ok) {
      throw new Error(`FOREIGN_ENDPOINT: ${urlCheck.reason ?? this.config.baseURL}`);
    }

    const result = await requestJson<{ choices?: unknown }>(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(this.config.headers ?? {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature,
          stream: false,
          ...(options.plain ? {} : thinkingSwitch(this.config.model)),
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      },
      {
        timeoutMs: this.config.timeoutMs ?? 45_000,
        retries: this.config.retries ?? 2,
        signal: signal ?? this.config.signal,
        onRetry: this.config.onRetry,
      },
    );

    if (!result.ok) {
      const detail = errorDetailFromText(result.text);
      throw new Error(`LLM_HTTP_${result.status}: ${detail.slice(0, 200)}`);
    }
    if (!result.data) {
      // 网关有时回 200 + 一段 HTML，旧代码会在 response.json() 处抛一个
      // 看不懂的 SyntaxError。这里明确说清是服务商那边没给 JSON。
      throw new Error(`LLM_BAD_JSON: ${result.text.slice(0, 120)}`);
    }

    const choices = result.data.choices;
    const content = Array.isArray(choices)
      ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
      : undefined;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('LLM_EMPTY_RESPONSE');
    }
    return content;
  }

  /** 轻量连通性探测：先用一句最短的话确认「地址 + Key + 模型」三件事都对。 */
  async ping(): Promise<{ ok: true; latencyMs: number; reply: string }> {
    const started = Date.now();
    const reply = await this.chat([{ role: 'user', content: '你好' }], 0);
    return { ok: true, latencyMs: Date.now() - started, reply: reply.slice(0, 60) };
  }

  /** 拉取服务商的模型列表（部分网关不提供，调用方要容错）。 */
  async listModels(): Promise<string[]> {
    if (!this.config.apiKey) throw new Error('MISSING_API_KEY');
    const urlCheck = checkDomesticURL(this.config.baseURL);
    if (!urlCheck.ok) throw new Error(`FOREIGN_ENDPOINT: ${urlCheck.reason ?? ''}`);

    const result = await requestJson<{ data?: unknown; models?: unknown }>(
      `${this.baseURL}/models`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      },
      {
        timeoutMs: 15_000,
        retries: 1,
        signal: this.config.signal,
        onRetry: this.config.onRetry,
      },
    );

    if (!result.ok) {
      const detail = errorDetailFromText(result.text);
      throw new Error(`LLM_HTTP_${result.status}: ${detail.slice(0, 200)}`);
    }

    // 两种形状都要认：OpenAI 是 `{data:[{id}]}`，部分国产网关是 `{models:[{id}]}`。
    const raw = result.data?.data ?? result.data?.models;
    const list = Array.isArray(raw) ? raw : [];
    return list
      .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
}

/**
 * 这次失败值不值得「换个请求体再试一次」？
 *
 * 只有 400 / 404 / 422 这类「你说的话我听不懂」才可能在换掉
 * `response_format` / `enable_thinking` 之后变通。鉴权（401/403）、欠费（402）、
 * 限流（429）和 5xx 换什么 body 都一样，必须立刻如实报出去。
 */
export function isDowngradableHttpError(message: string): boolean {
  const match = message.match(/LLM_HTTP_(\d{3})/);
  if (!match) return false;
  const status = Number(match[1]);
  return status === 400 || status === 404 || status === 422;
}
