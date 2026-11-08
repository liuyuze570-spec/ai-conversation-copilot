/**
 * 模型返回的 JSON —— 结构校验。
 *
 * 为什么单独一个文件：模型（尤其是免费 7B/9B 小模型）回来的东西**形状**是
 * 不可信的。实测见过这些：
 *   · `"replies"` 不是数组，而是一个字符串或直接一个对象；
 *   · `"chinese": 123`（数字）—— 旧代码写 `(item.chinese ?? '').trim()`，
 *     数字没有 `.trim()`，**整个回复直接抛 TypeError**，用户看到的是「连接失败」；
 *   · `"kind": "随便写的"`，界面上就会拿到一个不存在的键；
 *   · `"syllables": "not·an·array"`；
 *   · 同一个句子重复出现三四遍。
 *
 * 所以这里做三件事：逐字段**收敛类型**、丢弃不认识的枚举、按原顺序去重。
 * 校验完仍然是空数组的话，调用方当作「这次没返回有效回复」处理，而不是抛错。
 */

/** 界面上真实存在的三种卡片。`kind` 落在这三个以外一律当 natural。 */
export const REPLY_KINDS = ['simple', 'natural', 'continue'] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

export interface ValidatedDraft {
  kind: ReplyKind;
  english: string;
  chinese: string;
  meaning?: string;
  ipa?: string;
  syllables?: string[];
  chinesePronunciation?: string;
  readingHint?: string;
  romanization?: string;
}

/** 单字段长度上限：模型偶尔会整段复读，别让它撑爆界面和气泡。 */
const MAX_TEXT = 600;
const MAX_PRON = 200;

function asText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function asKind(value: unknown): ReplyKind {
  return typeof value === 'string' && (REPLY_KINDS as readonly string[]).includes(value)
    ? (value as ReplyKind)
    : 'natural';
}

function asSyllables(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
    .slice(0, 40);
  return list.length ? list : undefined;
}

/**
 * 把解析出来的任意 JSON 收成一组可用卡片。
 *
 * 容忍三种常见形状：
 *   1. `{ replies: [...] }`（提示词要求的标准形状）
 *   2. `{ english: ... }`（模型忘了包一层）
 *   3. `[ {...}, {...} ]`（模型直接返回数组）
 */
export function parseReplyDrafts(parsed: unknown, max = 3): ValidatedDraft[] {
  const candidates = collectCandidates(parsed);
  const seen = new Set<string>();
  const out: ValidatedDraft[] = [];

  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const english = asText(raw.english);
    if (!english) continue;
    // 同一句话出现两次没有任何用，占地方又让人以为模型抽风了。
    const key = english.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    /*
     * 0.6.0 的提示词让模型输出 `meaning` / `readingHint`（与理解语言、
     * 提示体系无关的通用字段）。老模型、老缓存里仍然是 `chinese` /
     * `chinesePronunciation`，两个都收，新的优先 —— 这样历史记录、
     * 以及用户自己配的第三方中转，都不会因为换了字段名就整条空掉。
     */
    const meaning = asText(raw.meaning) ?? asText(raw.chinese) ?? '';
    out.push({
      kind: asKind(raw.kind),
      english,
      chinese: meaning,
      meaning,
      ipa: asText(raw.ipa, MAX_PRON),
      syllables: asSyllables(raw.syllables),
      chinesePronunciation: asText(raw.chinesePronunciation, MAX_PRON),
      readingHint: asText(raw.readingHint, MAX_PRON),
      romanization: asText(raw.romanization, MAX_PRON),
    });
    if (out.length >= max) break;
  }

  return out;
}

function collectCandidates(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.replies)) return record.replies;
  // 单张卡被漏包了一层：只要它有 english 就当一张卡。
  if ('english' in record) return [record];
  return [];
}
