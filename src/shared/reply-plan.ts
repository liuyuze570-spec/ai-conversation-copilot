/**
 * 情境回复：翻译完之后，给使用者三条**现在就能说出口**的英语句子。
 *
 * 为什么不能写死三句通用模板：
 * 对方说「定金 300，尾款 900」时，最该问的是「这是哪种币」；说「改到周五」
 * 时，最该问的是「之前是周三对吧」。永远只给「请再说一遍」的话，用户还得
 * 自己想措辞 —— 而他想不出来的正是这句英语。
 *
 * 三条铁律（都写进测试）：
 *  1. 不替用户答应任何事：不出现 I'll pay / I'll be there / 我会准时到 这类句子；
 *  2. 不假设用户是听障人士（不写 I'm deaf / 我听不见）；
 *  3. 句子里的数字、时间、币种只能来自**原话**，缺了就问，不许编。
 *
 * 生成方式全部是规则模板，不调用模型 —— 因此界面必须标「规则生成」。
 * 模型那条路（有 Key 时）另走 `/api/reply`，两端在界面上分开标注。
 */

import { planConfirmSentence, type ConfirmInput, type FactRole } from './facts';

export type ReplyKind = 'confirm' | 'clarify' | 'polite';

export interface ReplySegment {
  /** 这一段英语短语。 */
  en: string;
  /** 这一段的中文意思；拆不齐时为空串，卡片级中文仍然给全。 */
  zh: string;
  /** 这一段对应的汉字近音（由调用方注入的读音函数生成）。 */
  phon: string;
}

export interface PlannedReply {
  id: string;
  /** 用途，例如「确认金额并问币种」。 */
  purpose: string;
  kind: ReplyKind;
  en: string;
  zh: string;
  segments: ReplySegment[];
  /** 为什么给这一条 —— 让用户知道它对应哪一条事实。 */
  why: string;
}

/** 回复生成用到的最小事实形状。 */
export type ReplyFact = ConfirmInput & {
  kind?: string;
  /** 中文类名（「金额」「时间」），只能进中文句。 */
  label?: string;
  /** 对方原话里的叫法（deposit / remaining balance），英文句只能用它。 */
  labelEn?: string;
  currency?: string | null;
  role?: FactRole;
};

export interface ReplyPlanInput {
  original: string;
  translation?: string;
  facts: ReplyFact[];
  /** 源语言，目前只有英语有模板；其他语言只给澄清句。 */
  sourceLanguage?: string;
}

/** 币种代码 → 英语口语里的说法。 */
const CURRENCY_SPOKEN: Record<string, string> = {
  USD: 'dollars',
  EUR: 'euros',
  GBP: 'pounds',
  CNY: 'yuan',
  JPY: 'yen',
};

const HAS_CURRENCY_WORD = /美元|美金|欧元|日元|日圆|英镑|人民币|\b(?:usd|dollars?|euros?|yen|pounds?|rmb|cny)\b|[¥$€£]/i;

/**
 * 原话里的英语值 → 中文说法。
 *
 * 只翻**封闭集合**（星期、上下午、am/pm）。翻不出来就原样留着 ——
 * 中文句子里夹一个 Thursday 虽然难看，但比猜错一个日期安全得多；
 * 真正要做到的是让用户看清「不是哪个值」，而这个值他刚在看板上核对过。
 */
const WEEKDAY_ZH: Record<string, string> = {
  monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四',
  friday: '周五', saturday: '周六', sunday: '周日',
};
const PART_OF_DAY_ZH: Record<string, string> = {
  morning: '上午', afternoon: '下午', evening: '晚上', night: '夜里',
};

function zhValue(text: string): string {
  let out = (text ?? '').trim();
  for (const [en, zh] of Object.entries(WEEKDAY_ZH)) {
    out = out.replace(new RegExp(`\\b${en}\\b`, 'gi'), zh);
  }
  for (const [en, zh] of Object.entries(PART_OF_DAY_ZH)) {
    out = out.replace(new RegExp(`\\b${en}\\b`, 'gi'), zh);
  }
  return out
    .replace(/\ba\.?m\.?\b/gi, '上午')
    .replace(/\bp\.?m\.?\b/gi, '下午')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 原话里「这笔钱叫什么」的中文说法。
 *
 * 没有对应词就保留英文原词（`remaining balance 是 900`），不硬翻 ——
 * 翻错一个「定金/尾款」比留着英文更容易让人确认错。
 */
const MONEY_LABEL_ZH: Record<string, string> = {
  deposit: '定金',
  'security deposit': '押金',
  balance: '余额',
  'remaining balance': '余款',
  'outstanding balance': '未付余额',
  fee: '费用',
  fees: '费用',
  price: '价格',
  total: '总额',
  budget: '预算',
  rent: '租金',
  salary: '工资',
  amount: '金额',
  payment: '付款',
  cost: '成本',
  invoice: '发票金额',
  charge: '收费',
  quote: '报价',
};

function zhLabel(label: string): string {
  const key = (label ?? '').trim().toLowerCase();
  return MONEY_LABEL_ZH[key] ?? key;
}

/** 这条事实的币种，在**原话里**有没有说出来。 */
function saysCurrency(fact: ReplyFact): boolean {
  return Boolean(fact.currency) || HAS_CURRENCY_WORD.test(fact.value ?? '');
}

function moneyClause(fact: ReplyFact): string {
  const value = (fact.value ?? '').trim();
  const spoken = CURRENCY_SPOKEN[fact.currency ?? ''] ?? '';
  if (spoken && !HAS_CURRENCY_WORD.test(value)) return `${value} ${spoken}`;
  return value;
}

/**
 * 把一句英语按短语切开。
 *
 * 切在标点后面（`,` / `.` / `?`），不按词数硬切：念的时候一个短语一口气，
 * 用户需要的是「这一小段怎么读」，而不是逐词拼盘。
 */
export function splitPhrases(text: string): string[] {
  const parts = (text ?? '')
    .split(/(?<=[,.!?;])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [];
}

function splitChinese(text: string): string[] {
  return (text ?? '')
    .split(/[，,。！？；]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildSegments(en: string, zh: string, phon: (text: string) => string): ReplySegment[] {
  const enParts = splitPhrases(en);
  const zhParts = splitChinese(zh);
  const paired = enParts.length === zhParts.length;
  if (!enParts.length) return [{ en, zh, phon: phon(en) }];
  return enParts.map((part, index) => ({
    en: part,
    zh: paired ? zhParts[index] : '',
    phon: phon(part),
  }));
}

/** 把拆句/近音统一收口，保证每条卡形态一致。 */
function makeReply(
  base: Omit<PlannedReply, 'segments'>,
  phon: (text: string) => string,
): PlannedReply {
  return { ...base, segments: buildSegments(base.en, base.zh, phon) };
}

function isQuestion(text: string): boolean {
  return /\?\s*$/.test((text ?? '').trim()) || /^(?:can|could|would|will|do|does|did|is|are|am|what|when|where|who|why|how|may|should)\b/i.test((text ?? '').trim());
}

function hasApology(text: string): boolean {
  return /\b(?:sorry|apologies|apologize)\b|抱歉|对不起|すみません|죄송/i.test(text ?? '');
}

/**
 * 生成最多三条回复。
 *
 * 顺序固定为「确认 → 澄清 → 礼貌」，因为真实的沟通顺序就是这样：
 * 先确认听到的内容，再问不清的地方，最后收尾。三条都会出现，但内容随事实变。
 */
export function planReplies(input: ReplyPlanInput, phon: (text: string) => string): PlannedReply[] {
  const facts = (input.facts ?? []).filter((fact) => fact.value && !fact.negated);
  const money = facts.filter((fact) => fact.kind === 'money');
  const origin = facts.find((fact) => fact.role === 'origin');
  const current = facts.find((fact) => fact.role === 'current');
  const duration = facts.find((fact) => fact.role === 'duration');
  const negated = (input.facts ?? []).find((fact) => fact.negated);
  const english = (input.sourceLanguage ?? 'en').toLowerCase() === 'en';

  const out: PlannedReply[] = [];

  // ---- 1. 确认 ---------------------------------------------------------- //
  /*
   * 英文句里的叫法只能用对方自己的词（labelEn：deposit / remaining balance）。
   * `label` 是中文类名（「金额」），塞进英文句会写出「the 金额 is 300」——
   * 浏览器端实测出现过，对方看不懂，用户也不知道自己念了什么。
   */
  const enName = (fact: ReplyFact) => {
    const direct = (fact.labelEn ?? '').trim();
    if (direct && /^[a-zA-Z][a-zA-Z .'-]*$/.test(direct)) return direct;
    const label = (fact.label ?? '').trim();
    if (label && /^[a-zA-Z][a-zA-Z .'-]*$/.test(label)) return label;
    return 'amount';
  };
  if (english && money.length && money.every((fact) => enName(fact) !== 'amount' || (fact.labelEn ?? '').trim())) {
    const allUnknown = money.every((fact) => !saysCurrency(fact));
    const clause = money
      .map((fact) => `the ${enName(fact)} is ${moneyClause(fact)}`)
      .join(' and ');
    out.push(
      makeReply(
        {
          id: 'confirm-money',
          kind: 'confirm',
          purpose: allUnknown ? '确认金额，并问清币种' : '确认金额',
          en: `Just to confirm, ${clause}.${allUnknown ? ' What currency are these amounts in?' : ' Is that right?'}`,
          zh: `我确认一下：${money.map((fact) => `${zhLabel(fact.label ?? '')} 是 ${fact.value}`).join('、')}。${
            allUnknown ? '这些钱是什么币种？' : '对吗？'
          }`,
          why: allUnknown ? '原话没有说明币种，这是不能替你假设的一条' : '原话里带着币种，直接确认',
        },
        phon,
      ),
    );
  } else if (english && origin && current) {
    const tail = duration ? `, and it will still last ${duration.sourceText || duration.value}` : '';
    out.push(
      makeReply(
        {
          id: 'confirm-reschedule',
          kind: 'confirm',
          purpose: '确认改期（原先是什么、现在是什么）',
          en: `Just to confirm, it's now ${current.sourceText || current.value} instead of ${origin.sourceText || origin.value}${tail}. Is that right?`,
          zh: `我确认一下：现在改到${zhValue(current.value)}，不是原来的${zhValue(origin.value)}${duration ? `，时长还是${zhValue(duration.value)}` : ''}。对吗？`,
          why: '这句话里明确说了「改」，只确认新时间会被当成另一个约',
        },
        phon,
      ),
    );
  } else if (english && facts.length) {
    const plan = planConfirmSentence(facts, 'English', 'Chinese');
    if (plan.ok) {
      const label = facts[0]?.kind === 'money' ? '金额' : facts[0]?.kind === 'date' ? '日期' : facts[0]?.kind === 'time' ? '时间' : '关键信息';
      out.push(
        makeReply(
          {
            id: 'confirm-facts',
            kind: 'confirm',
            purpose: `确认${label}`,
            en: plan.sentence,
            zh: plan.meaning,
            why: '句子里的每个值都来自原话，没有额外补充',
          },
          phon,
        ),
      );
    }
  }

  // ---- 2. 澄清 ---------------------------------------------------------- //
  if (english) {
    if (money.length && money.some((fact) => !saysCurrency(fact))) {
      out.push(
        makeReply(
          {
            id: 'clarify-currency',
            kind: 'clarify',
            purpose: '单独问币种',
            en: 'Sorry — what currency is that in?',
            zh: '不好意思，这是哪种币？',
            why: '原话只说了数字，没说币种',
          },
          phon,
        ),
      );
    } else if (origin && current) {
      out.push(
        makeReply(
          {
            id: 'clarify-reschedule',
            kind: 'clarify',
            purpose: '请对方再确认新旧时间',
            en: `Sorry, just to be sure — ${current.sourceText || current.value}, not ${origin.sourceText || origin.value}?`,
            zh: `不好意思，再确认一下：是${zhValue(current.value)}，不是${zhValue(origin.value)}？`,
            why: '改期句最容易记反的就是新旧两个时间',
          },
          phon,
        ),
      );
    } else if (negated) {
      out.push(
        makeReply(
          {
            id: 'clarify-negation',
            kind: 'clarify',
            purpose: '请对方确认被否定的那个值',
            en: `Sorry, so it's not ${negated.sourceText || negated.value}, right?`,
            zh: `不好意思，所以不是${zhValue(negated.value)}，对吗？`,
            why: '这句话里有被否定的信息，确认一次比记错强',
          },
          phon,
        ),
      );
    }
    if (out.length < 3) {
      out.push(
        makeReply(
          {
            id: 'clarify-slower',
            kind: 'clarify',
            purpose: '请对方说慢一点或再说一遍',
            en: 'Sorry, could you say that again a little slower?',
            zh: '不好意思，能再慢一点说一遍吗？',
            why: '通用且不冒犯；没有说「我听不见」',
          },
          phon,
        ),
      );
    }
  } else {
    out.push(
      makeReply(
        {
          id: 'clarify-slower',
          kind: 'clarify',
          purpose: '请对方说慢一点（这一种语言只有这一条模板）',
          en: 'Sorry, could you say that again a little slower?',
          zh: '不好意思，能再慢一点说一遍吗？',
          why: '目前只有英语模板；其他语种的回复还没有逐句核对过',
        },
        phon,
      ),
    );
  }

  // ---- 3. 礼貌收尾 ------------------------------------------------------ //
  if (out.length < 3) {
    if (hasApology(input.original)) {
      out.push(
        makeReply(
          {
            id: 'polite-apology',
            kind: 'polite',
            purpose: '对方在道歉时回应',
            en: "That's all right, no worries.",
            zh: '没关系，别在意。',
            why: '对方说了抱歉，这句最自然',
          },
          phon,
        ),
      );
    } else if (isQuestion(input.original)) {
      out.push(
        makeReply(
          {
            id: 'polite-check',
            kind: 'polite',
            purpose: '对方在提问时的礼貌回应（不承诺任何事）',
            en: 'Thanks — let me check and get back to you.',
            zh: '谢谢，我确认一下再回复你。',
            why: '只承诺「回复」，不承诺付款、出席或完成',
          },
          phon,
        ),
      );
    } else {
      out.push(
        makeReply(
          {
            id: 'polite-got-it',
            kind: 'polite',
            purpose: '表示已经听懂',
            en: "Thank you, I've got it.",
            zh: '谢谢，我记下了。',
            why: '对方在给信息，这句最短最稳',
          },
          phon,
        ),
      );
    }
  }

  /*
   * 第三张兜底：请对方打字。
   *
   * 听障使用者最常见的处境不是「没听清」，是「语音本身就不是我的通道」。
   * 这条对任何输入都成立，不冒犯、不暴露听力状况，而且真的解决问题。
   * 它排在最后：有具体事实时，前三张都更值得占位置。
   */
  if (out.length < 3 && english && !out.some((card) => card.id === 'ask-type')) {
    out.push(
      makeReply(
        {
          id: 'ask-type',
          kind: 'clarify',
          purpose: '请对方打字（语音不是唯一通道）',
          en: 'Sorry, could you type that instead? It is easier for me.',
          zh: '不好意思，能打字给我吗？这样更方便。',
          why: '不说「我听不见」，只说「打字更方便」',
        },
        phon,
      ),
    );
  }

  return out.slice(0, 3);
}

/** 卡片上「这一条从哪来」的诚实标注。 */
export const REPLY_SOURCE_NOTE = {
  rule: '规则生成（按原话里的事实拼的，不是模型写的）',
  model: 'AI 建议（模型生成，请自己判断要不要说）',
  preset: '预置演示句',
} as const;
