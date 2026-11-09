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
import { contextWindow } from './caption-pipeline';

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
  /**
   * 累积的前文（最近几句）。影视对白常出现 "Yeah." / "Right." 这类短句，
   * 只看当前句会一直落回同一句通用回复 —— 借上一句判断场景才接得住。
   */
  context?: string[];
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

/** 中文字符。英文句子里出现任意一个，就说明把中文展示值拼进来了。 */
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 英文句子里的「值」：数字和币种分别取，绝不把中文展示值拼进来。
 *
 * 双语事实合并之后 `value` 是给中文用户看的（「450欧元」），`sourceText`
 * 才是对方原话（「450 euros」）。旧代码直接把 `value` 塞进英文模板，
 * 于是线上出现 `the deposit is 450欧元` —— 对方看不懂，用户照着念也尴尬。
 *
 * 三条规则：
 *  1. 数字从**原话片段**抽；抽不到才退回中文展示值里的数字（同一个数，不会变）。
 *  2. 币种只走 `currency` 代码 → 英语口语词（EUR → euros），不用中文词。
 *  3. 原话本来就是英文且带着币种词（`450 euros`），照抄原话，不重复补一遍。
 *
 * 推不出数字就返回空串：宁可让这条确认句不成立，也不编一个金额出来。
 */
function englishAmount(fact: ReplyFact): string {
  const source = (fact.sourceText ?? '').trim();
  const shown = (fact.value ?? '').trim();
  const digits =
    source.match(/\d[\d,]*(?:\.\d+)?/)?.[0] ??
    shown.match(/\d[\d,]*(?:\.\d+)?/)?.[0] ??
    '';
  if (!digits) return '';

  // 原话侧已经是英文写法（450 euros / $450）：照抄，保留对方自己的说法。
  if (source && !CJK.test(source) && /[a-zA-Z$€£¥]/.test(source)) {
    const cleaned = source.replace(/[,，]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!CJK.test(cleaned)) return cleaned;
  }

  const spoken = CURRENCY_SPOKEN[fact.currency ?? ''] ?? '';
  return spoken ? `${digits} ${spoken}` : digits;
}

/**
 * 时长等非金额片段进英文句子时的守卫。
 *
 * 改期确认句要带「still last ninety minutes」。合并后 `value` 可能是
 * 「90分钟」，这里只放行纯 ASCII 的原话片段；中文片段一律不进英文句，
 * 由调用方退化成不带时长的说法（不会凭空造单位）。
 */
function englishFragment(fact: ReplyFact): string {
  const source = (fact.sourceText ?? '').trim();
  return source && !CJK.test(source) ? source : '';
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
 * 无事实句子的场景分类。
 *
 * 影视对白、寒暄、叙述里没有金额/日期/时间可以核对，旧版只能给三条
 * 写死的兜底句（「请说慢一点」「我记下了」「请打字」），于是每一句台词
 * 看起来都一模一样。这里按句式和内容分场景，让回复真的跟着内容变。
 *
 * 仍然是**规则**，不是模型；界面不许写「AI 生成」。
 */
export type ContentScene =
  | 'greeting' | 'thanks' | 'apology' | 'question' | 'farewell'
  | 'invitation' | 'superlative' | 'opinion' | 'story' | 'statement';

const SCENE_PATTERNS: Array<[ContentScene, RegExp]> = [
  ['thanks', /\b(?:thank you|thanks|thank u|appreciate it|much appreciated)\b|谢谢|感谢/i],
  ['apology', /\b(?:sorry|apologi[sz]e|apologies|my bad|forgive me)\b|抱歉|对不起/i],
  // 问候要排在道别前面： "Hi there, good to see you." 里的 "see you"
  // 会被 farewell 的 see you 误抓，实测过。
  ['greeting', /^(?:hi|hello|hey|good morning|good afternoon|good evening|how are you|how's it going)\b|你好|早上好/i],
  ['farewell', /\b(?:goodbye|bye\b|see you|take care|good night|talk later)\b|再见/i],
  ['invitation', /\b(?:let's|let us|would you like|how about|shall we|do you want|want to|can you join|come with)\b/i],
  ['question', /\?\s*$|？\s*$|^(?:what|why|how|when|where|who|which|can|could|would|will|do|does|did|is|are|am|may|should|have|has)\b/i],
  ['superlative', /\b(?:biggest|best|worst|greatest|largest|longest|shortest|fastest|hardest|easiest|most|least|first time|ever done|ever seen|ever had|incredible|amazing|unbelievable|definitely|absolutely)\b/i],
  ['opinion', /\b(?:i think|i feel|i believe|i guess|i suppose|in my opinion|seems|probably|maybe|personally|to be honest)\b/i],
  ['story', /\b(?:was|were|had|did|went|said|told|happened|started|then|yesterday|last night|ago)\b/i],
];

/** 取真正的前一句；调用方即使把当前句也塞进上下文，也不会拿自己当背景。 */
function priorLine(context: string[], current: string): string {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const item = (context[index] ?? '').trim();
    if (item && item !== current) return item;
  }
  return '';
}

export function detectScene(text: string, context: string[] = []): ContentScene {
  const current = (text ?? '').trim();
  const letters = current.replace(/[^\p{L}\p{N}]/gu, '');
  // 短句（"Yeah." / "Right." / "Wow."）借上一句判场景，否则连续对白
  // 会一次次落回 statement，回复又变回固定的了。
  const sample = letters.length >= 6 ? current : `${priorLine(context, current)} ${current}`.trim();
  for (const [scene, pattern] of SCENE_PATTERNS) {
    if (pattern.test(sample)) return scene;
  }
  return 'statement';
}

interface ContentLine {
  purpose: string;
  en: string;
  zh: string;
  why: string;
}

interface SceneLines {
  primary: ContentLine;
  follow: ContentLine;
  /** 第三张始终是「请求重复/放慢/打字」，只是按场景换一种更自然的说法。 */
  clarify: 'slower' | 'type';
}

const SCENE_LINES: Record<ContentScene, SceneLines> = {
  greeting: {
    primary: { purpose: '回应问候', en: 'Hi, good to see you.', zh: '嗨，见到你真好。', why: '对方在打招呼，先把话接住' },
    follow: { purpose: '把对话接下去', en: "How's your day going?", zh: '今天过得怎么样？', why: '一个不需要承诺任何事的开放问题' },
    clarify: 'slower',
  },
  thanks: {
    primary: { purpose: '回应道谢', en: "You're welcome.", zh: '不客气。', why: '对方在道谢，一句就够' },
    follow: { purpose: '简短收尾', en: 'No problem at all.', zh: '没事，不客气。', why: '短、自然，不涉及任何承诺' },
    clarify: 'type',
  },
  apology: {
    primary: { purpose: '回应道歉', en: "That's all right, no worries.", zh: '没关系，别在意。', why: '对方说了抱歉，这句最自然' },
    follow: { purpose: '让对方放心', en: "It happens — don't worry about it.", zh: '常有的事，别放在心上。', why: '不追究、不指责，也不替你原谅具体的事' },
    clarify: 'slower',
  },
  farewell: {
    primary: { purpose: '回应道别', en: 'See you, take care.', zh: '回头见，保重。', why: '对方在收尾，跟着收尾' },
    follow: { purpose: '简短道别', en: 'Talk soon.', zh: '回头聊。', why: '不约定具体时间，不替你答应下次见面' },
    clarify: 'type',
  },
  invitation: {
    primary: { purpose: '回应邀请（不替你答应）', en: 'Thanks for asking — let me check and get back to you.', zh: '谢谢你想到我，我确认一下再回复你。', why: '只承诺「回复」，不承诺出席或参加' },
    follow: { purpose: '先要细节', en: 'Could you send me the details in writing?', zh: '能把细节用文字发我吗？', why: '拿到细节再决定，不用当场表态' },
    clarify: 'type',
  },
  question: {
    primary: { purpose: '回答提问（不硬答）', en: 'Good question — let me check and get back to you.', zh: '问得好，我确认一下再回复你。', why: '不知道就不编答案，只承诺回复' },
    follow: { purpose: '争取一点时间', en: 'Could you give me a moment to look that up?', zh: '能给我一点时间查一下吗？', why: '请对方等一下，不制造新信息' },
    clarify: 'type',
  },
  superlative: {
    primary: { purpose: '回应对方的强调', en: "That sounds impressive — the biggest one you've done?", zh: '听起来很了不起——是你做过最大的一次吗？', why: '原话用了最高级，顺着确认一次；用问句，不替你下结论' },
    follow: { purpose: '请对方接着讲', en: 'What was it like working on it?', zh: '做的时候是什么感觉？', why: '对方在讲经历，接一个开放问题就能继续聊' },
    clarify: 'slower',
  },
  opinion: {
    primary: { purpose: '回应对方的观点', en: "That's interesting — could you tell me a bit more?", zh: '挺有意思，能再多说一点吗？', why: '顺着话题，不替你站队' },
    follow: { purpose: '请对方展开', en: 'What makes you say that?', zh: '你为什么会这么想？', why: '请对方解释，不替你附和' },
    clarify: 'slower',
  },
  story: {
    primary: { purpose: '接着听对方讲', en: 'Right, and what happened next?', zh: '嗯，后来呢？', why: '对方在讲经过，接一句就能继续听下去' },
    follow: { purpose: '请对方重说后半句', en: 'Could you say that last part again a little slower?', zh: '最后那部分能再慢一点说一遍吗？', why: '叙事最容易漏掉的正是后半句' },
    clarify: 'type',
  },
  statement: {
    primary: { purpose: '表示收到', en: 'I see — thanks for letting me know.', zh: '明白了，谢谢你告诉我。', why: '对方在陈述，先表示听懂了' },
    follow: { purpose: '请对方补充', en: 'Could you say a bit more about that?', zh: '能就这个再说说吗？', why: '不替你猜意思，请对方多说一点' },
    clarify: 'slower',
  },
};

const CLARIFY_LINES: Record<'slower' | 'type', ContentLine> = {
  slower: {
    purpose: '请对方说慢一点或再说一遍',
    en: 'Sorry, could you say that again a little slower?',
    zh: '不好意思，能再慢一点说一遍吗？',
    why: '通用且不冒犯；没有说「我听不见」',
  },
  type: {
    purpose: '请对方打字（语音不是唯一通道）',
    en: 'Sorry, could you type that instead? It is easier for me.',
    zh: '不好意思，能打字给我吗？这样更方便。',
    why: '不说「我听不见」，只说「打字更方便」',
  },
};

/**
 * 按内容生成三张卡：内容回应 → 内容追问 → 通用澄清。
 * 前两张随场景变，第三张保住「请求重复/放慢/澄清」这条底线。
 */
export function contentReplies(
  scene: ContentScene,
  context: string[] = [],
): Array<Omit<PlannedReply, 'segments'>> {
  const lines = SCENE_LINES[scene];
  const suffix = context.length ? `（已结合前面 ${context.length} 句）` : '';
  const clarify = CLARIFY_LINES[lines.clarify];
  return [
    {
      id: `content-${scene}-primary`, kind: 'polite',
      purpose: lines.primary.purpose, en: lines.primary.en, zh: lines.primary.zh,
      why: lines.primary.why + suffix,
    },
    {
      id: `content-${scene}-follow`, kind: 'clarify',
      purpose: lines.follow.purpose, en: lines.follow.en, zh: lines.follow.zh,
      why: lines.follow.why + suffix,
    },
    {
      id: `content-${scene}-clarify`, kind: 'clarify',
      purpose: clarify.purpose, en: clarify.en, zh: clarify.zh, why: clarify.why,
    },
  ];
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
  const amounts = money.map(englishAmount);
  if (
    english &&
    money.length &&
    amounts.every(Boolean) &&
    money.every((fact) => enName(fact) !== 'amount' || (fact.labelEn ?? '').trim())
  ) {
    const allUnknown = money.every((fact) => !saysCurrency(fact));
    const clause = money
      .map((fact, index) => `the ${enName(fact)} is ${amounts[index]}`)
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
    const durationEnglish = duration ? englishFragment(duration) : '';
    const tail = durationEnglish ? `, and it will still last ${durationEnglish}` : '';
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

  /*
   * 无事实可核对时（影视对白、寒暄、叙述），旧版三条全是写死的兜底句，
   * 于是每一句台词看起来都一样 —— 线上截图确实如此。这里按当前句 +
   * 前文场景重新生成三张，前两张随内容变，第三张保住「请求重复/放慢/澄清」。
   *
   * 金额 / 币种 / 否定 / 改期 / 时长只要有事实，就完全不进这个分支，
   * P0 那些回归句子看到的仍是原来的确认句。
   */
  const factual = money.length > 0 || Boolean(origin && current) ||
    facts.length > 0 || Boolean(negated);
  if (english && !factual) {
    const context = contextWindow(input.context ?? []);
    const scene = detectScene(input.original, context);
    for (const item of contentReplies(scene, context)) {
      out.push(makeReply(item, phon));
    }
    return out.slice(0, 3);
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
  rule: '按当前内容生成（本地规则，不是模型）',
  model: 'AI 建议（模型生成，请自己判断要不要说）',
  preset: '预置演示句',
} as const;

/**
 * 真 AI 的开关说明。服务端 `/api/reply` 本来就有 ProviderReply（云端模型），
 * 只是没配凭据时会退化成模板句；配置后 `askReply()` 自动把三张卡换成 AI 建议。
 * 这句话要让用户看得见「现在不是 AI」以及「怎么让它变成 AI」，不许含糊。
 */
export const REPLY_MODEL_HINT =
  'AI 模型回复当前未配置。服务端设置 COPILOT_LLM_BASE_URL / COPILOT_LLM_API_KEY / COPILOT_LLM_MODEL 后，' +
  '翻译完成会自动改用模型生成的回复，并标注「AI 建议」。现在这三张是按内容生成的本地规则，不是 AI。';
