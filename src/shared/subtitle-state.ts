/**
 * 字幕译文的四种状态。
 *
 * 审计要求：「字幕要明确区分等待、成功、失败和取消，并提供逐句重试入口」。
 * 以前失败的译文只是永远显示一个 `…`，用户看到的和「还在翻」完全一样，
 * 既不知道该等还是该重试，也没有任何动作可做。
 *
 * 这里把「一行字幕下方该显示什么」做成纯函数，`reliability-unit` 可以直接测，
 * 不用起界面。
 */

export type TranslationState = 'idle' | 'pending' | 'ok' | 'failed' | 'cancelled';

export interface TranslationView {
  /** 最终落到界面上的状态（有译文时一律视为 ok）。 */
  state: TranslationState;
  /** 没有译文时显示在这一行的短文案；有译文时为 null。 */
  placeholder: string | null;
  /** 要不要给「重试」入口。 */
  canRetry: boolean;
}

export function translationView(input: {
  translatedText?: string | null;
  translationState?: TranslationState;
  partial?: boolean;
}): TranslationView {
  const text = (input.translatedText ?? '').trim();
  /*
   * 有译文就是成功 —— 哪怕之后整句重译失败。已经能看懂的意思不该因为
   * 第二次请求出错而变回「翻译失败」。
   */
  if (text) return { state: 'ok', placeholder: null, canRetry: false };

  // 半句话还在识别中，译文本来就没有，别催它。
  if (input.partial) return { state: 'pending', placeholder: '翻译中…', canRetry: false };

  switch (input.translationState) {
    case 'pending':
      return { state: 'pending', placeholder: '翻译中…', canRetry: false };
    case 'failed':
      return { state: 'failed', placeholder: '翻译失败', canRetry: true };
    // 停止监听把在途请求作废了：这不是失败，用词要区分开。
    case 'cancelled':
      return { state: 'cancelled', placeholder: '已停止翻译', canRetry: true };
    default:
      return { state: 'idle', placeholder: null, canRetry: false };
  }
}

/** 停止监听时，把还在路上的译文字幕标成「已取消」。 */
export function cancelPendingTranslation(
  state: TranslationState | undefined,
): TranslationState | undefined {
  return state === 'pending' ? 'cancelled' : state;
}
