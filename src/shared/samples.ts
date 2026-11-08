import type { FactCertainty, FactKind } from './facts';
import type { ComprehensionLanguage } from './languages';

/**
 * 三组可体验样例（比赛要求「至少 3 条可体验的测试样例 / 3 个输入输出样例」）。
 *
 * ⚠️ 证据等级必须写清楚，不能混：
 *
 * - 这里的 `original` / `translation` 是**预置文本**，把它们塞进字幕区只能证明
 *   「界面能读、事实卡能认」，**不能**当作真实识别或真实翻译的结果。
 * - 自动化测试跑 `extractFactsWithRules()` 只能证明**规则逻辑**，不能证明语音
 *   识别准不准。
 * - 只有「真实音频 → 真实 STT → 真实 LLM 翻译」走完一遍，才算那条链路的测试
 *   结果（见交付文档里的记录表，未执行的项一律写「未执行」）。
 *
 * ## 为什么每句要写三个方向的版本（0.6.1 修）
 *
 * 0.6.0 的离线翻译只认「英语 → 中文」这张表，于是：
 *  - 用户把理解语言换成日语，字幕还是中文；
 *  - 把目标语言换成日语（理解语言英语）时，对方原话是日语，表里一句都没有，
 *    最后掉进关键词兜底，屏幕上出现「明天 / 下周」这种跟原句对不上的字。
 *
 * 现在三句样例各自带 `zh-en` / `ja-en` / `en-ja` 三个版本：原话、参考译文、
 * 该抓的重点、以及「哪条值必须被标成被否定」都按方向分开写。
 * 不在三个方向里的组合**没有**预置样例 —— 面板会直说，而不是拿中文顶上。
 */

export type SampleDirection = 'zh-en' | 'ja-en' | 'en-ja';

export interface SampleExpectation {
  kind: FactKind;
  /** 值里必须包含的片段（大小写不敏感）。 */
  includes: string;
  certainty?: FactCertainty;
}

export interface SampleVariant {
  /** 对方原话（外语；也是字幕原文与朗读文本）。 */
  original: string;
  /** 参考译文 —— 用使用者理解的语言写，人工写的，不是模型实测输出。 */
  translation: string;
  /** 这句要抓住的重点（人话）。 */
  focus: string[];
  expect: SampleExpectation[];
  /** 不允许出现的值（把被否定的值当成确定值时就是这种）。 */
  forbidValues?: string[];
}

export interface SampleCase {
  id: string;
  title: string;
  variants: Partial<Record<SampleDirection, SampleVariant>>;
}

/** 方向 → 使用者理解的语言。`null` 表示这个组合没有预置样例。 */
export const DIRECTION_COMPREHENSION: Record<SampleDirection, ComprehensionLanguage> = {
  'zh-en': 'Chinese',
  'ja-en': 'Japanese',
  'en-ja': 'English',
};

export function directionFor(
  comprehension: string | undefined,
  target: string | undefined,
): SampleDirection | null {
  if (comprehension === 'Chinese' && target === 'English') return 'zh-en';
  if (comprehension === 'Japanese' && target === 'English') return 'ja-en';
  if (comprehension === 'English' && target === 'Japanese') return 'en-ja';
  return null;
}

export const SAMPLE_CASES: SampleCase[] = [
  {
    id: 'sample-time',
    title: '样例 1 · 明天下午三点前交报告',
    variants: {
      'zh-en': {
        original: 'Please send the report by 3 p.m. tomorrow.',
        translation: '请在明天下午三点前把报告发过来。',
        focus: ['事项：发报告', '时间：下午三点', '日期：明天（相对表达，不换算成具体日期）'],
        expect: [
          { kind: 'time', includes: '3 p' },
          { kind: 'date', includes: 'tomorrow' },
        ],
        // 「明天」不能被悄悄换成某个具体日期。
        forbidValues: ['2026', 'November', '11月'],
      },
      'ja-en': {
        original: 'Please send the report by 3 p.m. tomorrow.',
        translation: '明日の午後3時までにレポートを送ってください。',
        focus: ['用件：レポートを送る', '時刻：午後3時', '日付：明日（相対表現のまま）'],
        expect: [
          { kind: 'time', includes: '3 p' },
          { kind: 'date', includes: 'tomorrow' },
        ],
        forbidValues: ['2026', 'November'],
      },
      'en-ja': {
        original: '明日の午後3時までにレポートを送ってください。',
        translation: 'Please send the report by 3 p.m. tomorrow.',
        focus: ['Task: send the report', 'Time: 3 p.m.', 'Date: tomorrow (keep the relative word)'],
        expect: [
          { kind: 'time', includes: '3時' },
          { kind: 'date', includes: '明日' },
        ],
        forbidValues: ['2026', 'November'],
      },
    },
  },
  {
    id: 'sample-moved',
    title: '样例 2 · 会议从周二改到周四 10:30',
    variants: {
      'zh-en': {
        original: 'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
        translation: '会议不在周二，改到周四上午 10 点 30 分了。',
        focus: ['否定：不是周二', '更正：周四', '时间：上午 10:30'],
        expect: [
          { kind: 'date', includes: 'thursday' },
          { kind: 'time', includes: '10:30' },
          // 周二必须作为「被否定」出现，不能是一条中性的日期卡。
          { kind: 'date', includes: 'tuesday', certainty: 'corrected' },
        ],
        forbidValues: ['Tuesday'],
      },
      'ja-en': {
        original: 'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
        translation: '会議は火曜日ではありません。木曜日の午前10時30分に変更になりました。',
        focus: ['否定：火曜日ではない', '変更後：木曜日', '時刻：午前10時30分'],
        expect: [
          { kind: 'date', includes: 'thursday' },
          { kind: 'time', includes: '10:30' },
          { kind: 'date', includes: 'tuesday', certainty: 'corrected' },
        ],
        forbidValues: ['Tuesday'],
      },
      'en-ja': {
        original: '会議は火曜日ではありません。木曜日の午前10時30分に変更になりました。',
        translation: 'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
        focus: ['Negation: not Tuesday', 'Changed to: Thursday', 'Time: 10:30 a.m.'],
        expect: [
          { kind: 'date', includes: '木曜日' },
          { kind: 'time', includes: '10時30分' },
          // 日语里否定在值后面（「5万ではありません」），规则必须能往右看。
          { kind: 'date', includes: '火曜日', certainty: 'corrected' },
        ],
        forbidValues: ['火曜日'],
      },
    },
  },
  {
    id: 'sample-budget',
    title: '样例 3 · 预算一万五，不是五万',
    variants: {
      'zh-en': {
        original: 'The budget is fifteen thousand, not fifty thousand.',
        translation: '预算是一万五千，不是五万。',
        focus: ['金额：15000', '纠正：不是 50000', '两个数字都要留着，别只留一个'],
        expect: [
          { kind: 'money', includes: 'fifteen thousand' },
          { kind: 'money', includes: 'fifty thousand', certainty: 'corrected' },
        ],
        forbidValues: ['fifty thousand'],
      },
      'ja-en': {
        original: 'The budget is fifteen thousand, not fifty thousand.',
        translation: '予算は1万5千で、5万ではありません。',
        focus: ['金額：1万5千', '訂正：5万ではない', '両方の数字を残す'],
        expect: [
          { kind: 'money', includes: 'fifteen thousand' },
          { kind: 'money', includes: 'fifty thousand', certainty: 'corrected' },
        ],
        forbidValues: ['fifty thousand'],
      },
      'en-ja': {
        original: '予算は1万5千で、5万ではありません。',
        translation: 'The budget is fifteen thousand, not fifty thousand.',
        focus: ['Amount: 15,000', 'Correction: not 50,000', 'Keep both numbers'],
        expect: [
          { kind: 'money', includes: '1万5千' },
          { kind: 'money', includes: '5万', certainty: 'corrected' },
        ],
        forbidValues: ['5万'],
      },
    },
  },
];

export function sampleById(id: string): SampleCase | undefined {
  return SAMPLE_CASES.find((item) => item.id === id);
}

/** 当前语言方向下可运行的样例（没有预置版本的方向返回空数组）。 */
export function samplesFor(
  comprehension: string | undefined,
  target: string | undefined,
): SampleCase[] {
  const direction = directionFor(comprehension, target);
  if (!direction) return [];
  return SAMPLE_CASES.filter((sample) => sample.variants[direction]);
}

export function sampleVariant(
  sample: SampleCase,
  direction: SampleDirection | null,
): SampleVariant | null {
  if (!direction) return null;
  return sample.variants[direction] ?? null;
}

/** 当前方向下这一句的样子；方向不支持时返回 null。 */
export function sampleFor(
  id: string,
  comprehension: string | undefined,
  target: string | undefined,
): { sample: SampleCase; variant: SampleVariant } | null {
  const sample = sampleById(id);
  if (!sample) return null;
  const variant = sampleVariant(sample, directionFor(comprehension, target));
  if (!variant) return null;
  return { sample, variant };
}

/**
 * 离线演示用的「理解语言 + 原话 → 参考译文」表。
 *
 * key = `${理解语言}|${原话}`。**必须按理解语言分开**，否则中文用户和日语用户
 * 会拿到同一句中文译文 —— 0.6.0 的「明天 / 下周」就是这么来的。
 */
export const SAMPLE_TRANSLATIONS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const sample of SAMPLE_CASES) {
    for (const [direction, variant] of Object.entries(sample.variants) as [
      SampleDirection,
      SampleVariant,
    ][]) {
      const comprehension = DIRECTION_COMPREHENSION[direction];
      map[`${comprehension}|${variant.original.trim()}`] = variant.translation;
    }
  }
  return map;
})();

export function sampleTranslationFor(text: string, comprehension: string): string | undefined {
  return SAMPLE_TRANSLATIONS[`${comprehension}|${text.trim()}`];
}

/** 样例卡上的一行摘要（设置页 / 交付文档共用）。 */
export function sampleSummary(sample: SampleCase, direction: SampleDirection | null): string {
  const variant = sampleVariant(sample, direction);
  return variant ? variant.focus.join(' · ') : '当前语言组合没有预置样例';
}
