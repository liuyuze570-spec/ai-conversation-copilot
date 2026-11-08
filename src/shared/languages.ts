/**
 * 语言方向：谁在听、想说什么、用什么字系给他标读音。
 *
 * 0.5.0 之前这套东西是写死的三件套：中文界面 + 中文译文 + 汉字近音。
 * 结果是一个日语使用者看到「卡梅拉」这种对他毫无意义的标注，一个英语使用者
 * 想要日语时又被塞了中文谐音。0.6.0 把它们拆成四个独立概念：
 *
 *   1. 界面语言   —— 软件自己的按钮和说明用什么语言（本版固定简体中文）
 *   2. 理解语言   —— 字幕/释义要翻成哪种语言（他要能看懂）
 *   3. 目标语言   —— 他要开口说的是哪种语言（对方听得懂）
 *   4. 读音提示   —— 用什么字系给他的目标语言标近似音
 *
 * 第 4 项不能由「理解语言」直接决定死：一个读得懂英语的听障者想去日本旅行，
 * 他要的是英文释义 + 罗马字，不是汉字近音。
 *
 * 另外还要强调一点：**不按国籍推断语言**。美国人未必以英语为母语，
 * 日本人也未必需要片假名。这些全部由用户自己选。
 */
import type { TargetLanguage } from './types';

/** 本版界面只有简体中文。留着这个类型是为了让「界面语言」是可表达的，而不是隐式的。 */
export type UiLanguage = 'zh-CN';

/** 「理解语言」目前允许选择的值。 */
export type ComprehensionLanguage = 'Chinese' | 'Japanese' | 'English' | 'Russian' | 'Korean';

/**
 * 读音提示体系。
 *
 * - `hanzi`    汉字近音（中文读者看英语/俄语/日语时的「谐音」）
 * - `katakana` 片假名近音（日语读者看英语时用）
 * - `romaji`   罗马字（英语读者看日语时用；也是日语词的拉丁转写）
 * - `none`     不显示提示
 */
export type HintSystem = 'hanzi' | 'katakana' | 'romaji' | 'none';

export const COMPREHENSION_LANGUAGES: { value: ComprehensionLanguage; label: string }[] = [
  { value: 'Chinese', label: '简体中文' },
  { value: 'Japanese', label: '日本語' },
  { value: 'English', label: 'English' },
  { value: 'Russian', label: 'Русский' },
  { value: 'Korean', label: '한국어' },
];

export const HINT_SYSTEMS: { value: HintSystem; label: string; sample: string }[] = [
  { value: 'hanzi', label: '汉字近音', sample: '哈喽' },
  { value: 'katakana', label: '片假名近音', sample: 'ハロー' },
  { value: 'romaji', label: '罗马字', sample: 'konnichiwa' },
  { value: 'none', label: '不显示', sample: '—' },
];

/** 一个完整的「语言方向」。 */
export interface LanguageDirection {
  comprehension: ComprehensionLanguage;
  target: TargetLanguage;
  hintSystem: HintSystem;
  /** 目标语言的地区/口音，只影响朗读选音，不影响文字。 */
  accent: string;
}

/**
 * 本轮真正实现并测过的三个方向。
 *
 * 只有在这里列出的组合才允许在界面上显示为「已支持」——其余组合仍然能跑
 * （模型会照常翻、提示会照常算），但没有对应的核对过样本，所以标「实验」。
 */
export const IMPLEMENTED_DIRECTIONS: {
  id: string;
  comprehension: ComprehensionLanguage;
  target: TargetLanguage;
  hintSystem: HintSystem;
  label: string;
  sample: string;
}[] = [
  {
    id: 'zh-en',
    comprehension: 'Chinese',
    target: 'English',
    hintSystem: 'hanzi',
    label: '中文 → 英语',
    sample: 'Please send the report by 3 p.m. tomorrow.',
  },
  {
    id: 'ja-en',
    comprehension: 'Japanese',
    target: 'English',
    hintSystem: 'katakana',
    label: '日本語 → 英語',
    sample: 'I will send the file by three.',
  },
  {
    id: 'en-ja',
    comprehension: 'English',
    target: 'Japanese',
    hintSystem: 'romaji',
    label: 'English → 日本語',
    sample: 'もう一度お願いします。',
  },
];

/** 方向 ID，也是缓存键的一部分。 */
export function directionId(direction: LanguageDirection): string {
  return `${direction.comprehension}>${direction.target}:${direction.hintSystem}:${direction.accent}`;
}

/** 这个方向是否在「已实现并测过」的清单里。 */
export function directionStatus(
  direction: LanguageDirection,
): 'verified' | 'structured' {
  const found = IMPLEMENTED_DIRECTIONS.some(
    (item) =>
      item.comprehension === direction.comprehension &&
      item.target === direction.target &&
      item.hintSystem === direction.hintSystem,
  );
  return found ? 'verified' : 'structured';
}

/**
 * 默认读音提示体系。
 *
 * 只按「理解语言」给一个**起点**，用户随时可以改。比如中文读者默认汉字近音，
 * 但如果他其实认识罗马字，可以在设置里换成罗马字。
 */
export function defaultHintSystem(
  comprehension: ComprehensionLanguage,
  target: TargetLanguage,
): HintSystem {
  if (comprehension === 'Chinese') return 'hanzi';
  if (comprehension === 'Japanese') return 'katakana';
  if (comprehension === 'English') return target === 'Japanese' ? 'romaji' : 'none';
  // 俄语 / 韩语读者：本版没有对应的近音字系，宁可空着也不塞别人的字。
  return 'none';
}

/** 提示体系的中文名，用于标签与自检。 */
export function hintSystemLabel(system: HintSystem): string {
  return HINT_SYSTEMS.find((item) => item.value === system)?.label ?? '不显示';
}

/** 目标语言的 BCP-47 标签，朗读时用。 */
export function bcp47For(language: TargetLanguage, accent?: string): string {
  const fallback: Record<TargetLanguage, string> = {
    English: 'en-US',
    Japanese: 'ja-JP',
    Russian: 'ru-RU',
    Korean: 'ko-KR',
  };
  const tag = (accent ?? '').trim();
  if (!tag) return fallback[language];
  // 只接受「语言-地区」这种形状，别把用户输入的东西直接塞进 SpeechSynthesis。
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(tag) ? tag : fallback[language];
}

/** 可选口音（只列本版验证过的）。 */
export const ACCENTS: Record<TargetLanguage, { value: string; label: string }[]> = {
  English: [
    { value: 'en-US', label: '美式英语 en-US' },
    { value: 'en-GB', label: '英式英语 en-GB' },
  ],
  Japanese: [{ value: 'ja-JP', label: '日语 ja-JP' }],
  Russian: [{ value: 'ru-RU', label: '俄语 ru-RU' }],
  Korean: [{ value: 'ko-KR', label: '韩语 ko-KR' }],
};

/** 理解语言的可读名字（拼进提示词，模型不认识 'Chinese' 的简繁区别）。 */
export const COMPREHENSION_NAMES: Record<ComprehensionLanguage, string> = {
  Chinese: 'Simplified Chinese (简体中文)',
  Japanese: 'Japanese (日本語)',
  English: 'English',
  Russian: 'Russian (Русский)',
  Korean: 'Korean (한국어)',
};

/**
 * 从设置里取方向。
 *
 * `hintSystem` 可能是旧设置里没有的字段 —— 这时按理解语言给默认值，
 * 而不是退成 'hanzi'（否则日语用户又被塞了汉字近音）。
 */
export function directionFrom(settings: {
  nativeLanguage?: string;
  targetLanguage: TargetLanguage;
  hintSystem?: HintSystem;
  accent?: string;
}): LanguageDirection {
  const comprehension = (settings.nativeLanguage ?? 'Chinese') as ComprehensionLanguage;
  const known = COMPREHENSION_LANGUAGES.some((item) => item.value === comprehension);
  const safeComprehension: ComprehensionLanguage = known ? comprehension : 'Chinese';
  const system =
    settings.hintSystem ?? defaultHintSystem(safeComprehension, settings.targetLanguage);
  return {
    comprehension: safeComprehension,
    target: settings.targetLanguage,
    hintSystem: system,
    accent: bcp47For(settings.targetLanguage, settings.accent),
  };
}
