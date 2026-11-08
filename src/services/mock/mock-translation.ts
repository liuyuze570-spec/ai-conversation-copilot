import type { TranslateRequest, TranslationProvider } from '../types';
import { sampleTranslationFor } from '../../shared/samples';
import { TRANSLATIONS, WORD_HINTS } from './corpus';

/**
 * 离线演示用的翻译替身。
 *
 * ## 修掉的问题
 *
 * 旧实现只做三件事：命中 `TRANSLATIONS`（全是「英→中」）就返回；否则把
 * 命中的**关键词**用 ` / ` 连起来；再否则原样回显。
 * 于是用户实测到：
 *
 *  - 目标是中文时，`Please send the report by 3 p.m. tomorrow.` 这句不在表里，
 *    命中关键词 `tomorrow` → 屏幕上出现「明天 / 下周」，跟原句毫无对应关系；
 *  - `Tomorrow.` / `Next week.` / `See you tomorrow.` 三句都返回同一串
 *    「明天 / 下周」（`tomorrow` 和 `week` 两个关键词同时命中），用户分不清；
 *  - 理解语言换成日语时，返回值仍然是中文 —— 用户根本读不懂；
 *  - 目标语言是日语（理解语言英语）时，原话是日语，表里一句都没有。
 *
 * ## 现在的规则（顺序固定，每一层都必须「确有其句」）
 *
 * 1. 三组样例的预置译文（按「理解语言 + 原话」查）。
 * 2. 整句就是一个短句/时间状语（`Tomorrow.` / `Next week.` / `谢谢。`）→
 *    给**完整译文**。这一层是句子级，不是关键词级。
 * 3. 目标是中文：查场景语料表。
 * 4. 只认出关键词时，**明确标成「只认出关键词，不是译文」**，后面保留原话。
 * 5. 什么都没有：明说没有，不拿中文顶替。
 */

/** 提示文案里用的短名字：不把英文语言名和括号里的原文混进中文句子。 */
const SHORT_NAMES: Record<string, string> = {
  Chinese: '中文',
  Japanese: '日语',
  English: '英语',
  Russian: '俄语',
  Korean: '韩语',
};

/** 关键词兜底只对很短的句子开（「Thanks!」这种），长句拼出来的假译文比空着更糟。 */
const HINT_MAX_WORDS = 3;

/**
 * 整句短句 → 完整译文（按目标语言）。
 *
 * 这些不是「关键词拼接」：每一条都是一个能独立成立的句子。演示时对方说
 * `Tomorrow.`，屏幕上就该是「明天。」，而不是一串时间词。
 */
interface ShortPhrase {
  test: RegExp;
  Chinese?: string;
  Japanese?: string;
  English?: string;
}

const SHORT_PHRASES: ShortPhrase[] = [
  { test: /^see you tomorrow[.!。！]?$/i, Chinese: '明天见。', Japanese: 'また明日。' },
  { test: /^see you next week[.!。！]?$/i, Chinese: '下周见。', Japanese: 'また来週。' },
  { test: /^tomorrow[.!。！]?$/i, Chinese: '明天。', Japanese: '明日。', English: 'Tomorrow.' },
  { test: /^next week[.!。！]?$/i, Chinese: '下周。', Japanese: '来週。', English: 'Next week.' },
  { test: /^today[.!。！]?$/i, Chinese: '今天。', Japanese: '今日。', English: 'Today.' },
  { test: /^tonight[.!。！]?$/i, Chinese: '今晚。', Japanese: '今夜。', English: 'Tonight.' },
  { test: /^this afternoon[.!。！]?$/i, Chinese: '今天下午。', Japanese: '今日の午後。', English: 'This afternoon.' },
  { test: /^明天[。！.!]?$/, Chinese: '明天。', Japanese: '明日。', English: 'Tomorrow.' },
  { test: /^下周[。！.!]?$/, Chinese: '下周。', Japanese: '来週。', English: 'Next week.' },
  { test: /^谢谢[。！.!]?$/, Chinese: '谢谢。', Japanese: 'ありがとう。', English: 'Thank you.' },
  { test: /^thank you[.!。！]?$/i, Chinese: '谢谢。', Japanese: 'ありがとう。', English: 'Thank you.' },
  { test: /^thanks[.!。！]?$/i, Chinese: '谢谢。', Japanese: 'ありがとう。', English: 'Thanks.' },
  { test: /^sorry[.!。！]?$/i, Chinese: '对不起。', Japanese: 'すみません。', English: 'Sorry.' },
  { test: /^ok(ay)?[.!。！]?$/i, Chinese: '好的。', Japanese: 'わかりました。', English: 'OK.' },
];

function phraseFor(text: string, target: string): string | null {
  const clean = text.trim();
  for (const phrase of SHORT_PHRASES) {
    if (!phrase.test.test(clean)) continue;
    const value = phrase[target as 'Chinese' | 'Japanese' | 'English'];
    if (value) return value;
  }
  return null;
}

/**
 * 关键词兜底：**明确标成「只认出关键词」**，不冒充整句翻译。
 *
 * 返回值前面是方框说明、后面原样保留原话 —— 用户一眼能看出这不是译文，
 * 也不会把「明天」当成对方真的说了明天。
 */
function fallbackHints(text: string, target: string): string | null {
  if (target !== 'Chinese') return null;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > HINT_MAX_WORDS) return null;
  const hits = WORD_HINTS.filter(([pattern]) => pattern.test(text)).map(([, zh]) => zh);
  if (!hits.length) return null;
  const unique = [...new Set(hits)];
  return `〔演示模式只认出关键词：${unique.join('、')}；整句译文没有预置，不猜〕${text.trim()}`;
}

export function translateOffline(text: string, to: string): string {
  const trimmed = text.trim();
  const preset = sampleTranslationFor(trimmed, to);
  if (preset) return preset;

  // 整句短句：按目标语言给完整译文（明天 / 下周一目了然）。
  const phrase = phraseFor(trimmed, to);
  if (phrase) return phrase;

  if (to === 'Chinese') {
    const exact = TRANSLATIONS[trimmed];
    if (exact) return exact;
    const hinted = fallbackHints(trimmed, to);
    if (hinted) return hinted;
    return `〔演示模式没有这句的预置译文〕${trimmed}`;
  }

  // 非中文理解方向：只有三组样例和上面那几句短句有译文。没有就如实说明。
  const label = SHORT_NAMES[to] ?? to;
  return `〔演示模式没有这句的${label}译文，不拿中文顶替〕${trimmed}`;
}

export class MockTranslator implements TranslationProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock Translator (offline)';

  async translate(request: TranslateRequest): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (request.signal?.aborted) throw new Error('TRANSLATE_CANCELLED');
    return translateOffline(request.text, request.to);
  }
}
