/**
 * 「语言水平」的最权威定义：每种对话语言一套，各记各的。
 *
 * 为什么要分套：一个学日语的人被问「你的水平」时，答的是 JLPT N3；学韩语的是
 * TOPIK 3 级；学俄语的是「大学俄语四级 / 专业八级」。以前全软件只有一个英语
 * 等级下拉（B 级 / 四级 / 专八），选了日语之后那个下拉还在问英语水平 —— 用户
 * 既没法表达真实水平，模型也拿不到正确的难度刻度。
 *
 * 所以：`languageLevels` 按语言各存一个值，切换语言时互不覆盖（从日语切回英语，
 * 英语还是你原来选的四级）。
 */
import { ENGLISH_GRADES, type TargetLanguage } from './types';

export interface LevelOption {
  value: string;
  label: string;
  hint: string;
}

/** 每种语言当前选中的等级值。 */
export type LanguageLevels = Record<TargetLanguage, string>;

/**
 * 俄语：国内实际在考的几档。
 *
 * 「大学俄语四六级」面向非俄语专业，「俄语专业四八级」面向俄语专业 —— 和英语的
 * 四六级 / 专四专八一一对应，用户不需要学一套新名词。再加一档「入门」给完全
 * 刚开始的人：英语那边有「B 级」兜底，俄语没有对应的考试，只能直说。
 */
const RUSSIAN_LEVELS: LevelOption[] = [
  { value: 'ru-basic', label: '俄语入门', hint: '只会打招呼，能听懂最常用的词' },
  { value: 'ru-crt4', label: '大学俄语四级', hint: '日常交流基本够用，能接上一两句' },
  { value: 'ru-crt6', label: '大学俄语六级', hint: '能聊工作、新闻这类稍复杂的话题' },
  { value: 'ru-tr4', label: '俄语专业四级', hint: '俄语专业基础，听得懂地道说法' },
  { value: 'ru-tr8', label: '俄语专业八级', hint: '接近母语者，俚语和快语速都跟得上' },
];

/** 日语：JLPT（N5 最浅、N1 最深），国内学日语的人基本都用这套。 */
const JAPANESE_LEVELS: LevelOption[] = [
  { value: 'ja-n5', label: '日语 N5（入门）', hint: '刚学完五十音，只会最简单的句子' },
  { value: 'ja-n4', label: '日语 N4', hint: '能应付日常寒暄和购物这类场景' },
  { value: 'ja-n3', label: '日语 N3', hint: '日常对话能跟上，多数人的水平' },
  { value: 'ja-n2', label: '日语 N2', hint: '能听懂较自然的口语，看剧问题不大' },
  { value: 'ja-n1', label: '日语 N1', hint: '接近母语者，省略和俚语也听得懂' },
];

/** 韩语：TOPIK 1～6 级。 */
const KOREAN_LEVELS: LevelOption[] = [
  { value: 'ko-t1', label: '韩语 1 级（入门）', hint: '只会问候、自我介绍' },
  { value: 'ko-t2', label: '韩语 2 级', hint: '能应付点餐、问路这类日常场景' },
  { value: 'ko-t3', label: '韩语 3 级', hint: '日常对话能跟上一半，多数人的水平' },
  { value: 'ko-t4', label: '韩语 4 级', hint: '能聊工作、兴趣这类稍复杂的话题' },
  { value: 'ko-t5', label: '韩语 5 级', hint: '能听懂自然的韩语口语和综艺' },
  { value: 'ko-t6', label: '韩语 6 级', hint: '接近母语者，缩略语和方言也听得懂' },
];

/** 英语直接复用 `ENGLISH_GRADES`：B 级 / A 级 / 四级 / 六级 / 专四 / 专八。 */
export const LANGUAGE_LEVELS: Record<TargetLanguage, LevelOption[]> = {
  English: ENGLISH_GRADES,
  Russian: RUSSIAN_LEVELS,
  Japanese: JAPANESE_LEVELS,
  Korean: KOREAN_LEVELS,
};

/**
 * 每种语言第一次打开时的默认等级：都取「多数人的水平」，不是最高也不是最低 ——
 * 默认给太低，模型会说出「Good morning, how are you」这种让人尴尬的话。
 */
export const DEFAULT_LANGUAGE_LEVELS: LanguageLevels = {
  English: 'cet4',
  Russian: 'ru-crt4',
  Japanese: 'ja-n3',
  Korean: 'ko-t3',
};

export function levelsFor(language: TargetLanguage | string): LevelOption[] {
  return LANGUAGE_LEVELS[language as TargetLanguage] ?? ENGLISH_GRADES;
}

export function defaultLevelFor(language: TargetLanguage | string): string {
  return DEFAULT_LANGUAGE_LEVELS[language as TargetLanguage] ?? DEFAULT_LANGUAGE_LEVELS.English;
}

export function isKnownLevel(language: TargetLanguage | string, value: string): boolean {
  return levelsFor(language).some((option) => option.value === value);
}

/**
 * 某个语言当前选中的等级。
 *
 * 值不认识时（老设置文件、手工改坏、或者从别的语言串过来的）回默认值 —— 直接把
 * 非法值塞进提示词，模型会收到一句 "for a undefined learner"。
 */
export function levelFor(
  levels: Partial<Record<string, string>> | undefined,
  language: TargetLanguage,
): string {
  const value = levels?.[language];
  if (value && isKnownLevel(language, value)) return value;
  return defaultLevelFor(language);
}

export function levelLabel(language: TargetLanguage, value: string): string {
  const options = levelsFor(language);
  return (
    options.find((option) => option.value === value)?.label ??
    options.find((option) => option.value === defaultLevelFor(language))?.label ??
    value
  );
}
