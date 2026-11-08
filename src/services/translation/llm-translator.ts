import type { TranslationProvider, TranslateRequest } from '../types';
import { buildTranslateMessages } from '../llm/prompts';

export interface ChatLike {
  chat(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    temperature: number,
    /** 可选：取消信号（停止监听 / 关闭面板时掐掉在途翻译）。 */
    options?: { json?: boolean; plain?: boolean },
    signal?: AbortSignal,
  ): Promise<string>;
}

/**
 * Translation is done by the LLM instead of a dedicated MT API:
 * spoken-language translation needs context, and it keeps the MVP to a
 * single provider credential.
 */
export class LLMTranslator implements TranslationProvider {
  readonly id = 'llm-translator';
  readonly displayName = 'LLM Translator';

  constructor(private readonly llm: ChatLike) {}

  async translate(request: TranslateRequest): Promise<string> {
    if (!request.text.trim()) return '';
    const messages = buildTranslateMessages(request.text, request.context ?? [], {
      from: request.from,
      to: request.to,
    });
    const content = await this.llm.chat(
      messages.map((message) => ({
        role: message.role as 'system' | 'user' | 'assistant',
        content: message.content,
      })),
      // 字幕要的是「准」而不是「花」：温度低一点，避免模型自由发挥。
      0.1,
      {},
      // 停止监听 / 用户关掉面板时，这个信号会把在途请求真的掐断，
      // 而不是「跑完了再把结果丢掉」（省额度，也不会让旧结果回来改状态）。
      request.signal,
    );
    return content
      .trim()
      .replace(/^["'“”‘’]|["'“”‘’]$/g, '')
      .replace(/^(翻译|译文|中文|translation)[:：]\s*/i, '')
      .trim();
  }
}
