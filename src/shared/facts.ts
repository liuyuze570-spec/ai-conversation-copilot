/**
 * 「关键事实确认卡」的纯逻辑层。
 *
 * 目标：从实时双语对话里抓住**说清楚了的事实**（时间、地点、金额、事项…），
 * 让用户当场核对，而不是事后靠回忆。
 *
 * ## 三条硬规则（都是审计里明确要求的）
 *
 * 1. **只忠实转写，不许升格**。原话说「可能周五」，这里就必须还带着
 *    `certainty: 'uncertain'`，界面上标「待核对」；绝不能让模型把它写成
 *    「确定周五」。原话说「不是三点，是四点」，那是**更正**，取更正后的值。
 * 2. **原文片段必须真的能在字幕里找到**。所有产出都过 `validateFacts()`，
 *    对不上的整条丢弃 —— 宁可少一张卡，也不能给用户看一句他没听过的「原话」。
 * 3. **不编造置信度**。有疑问就写「待核对」，不显示任何百分比。
 *
 * ## 为什么时间/金额先用规则
 *
 * 数字是最容易规则化的，也是最不能再问一次模型的：一句话里有没有「三点」
 * 用正则就知道，没必要为它付一次延迟和费用。规则先跑，模型只补规则做不了的
 * （人名、组织、事项、负责人）。
 */

export const FACT_KINDS = [
  'time',
  'date',
  'place',
  'money',
  'quantity',
  'person',
  'org',
  'task',
  'owner',
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

/** 界面上的中文短标签（用户要求「简短中文标签配合外语原文」）。 */
export const FACT_LABELS: Record<FactKind, string> = {
  time: '时间',
  date: '日期',
  place: '地点',
  money: '金额',
  quantity: '数量',
  person: '人名',
  org: '机构',
  task: '事项',
  owner: '负责人',
};

export type FactCertainty = 'stated' | 'uncertain' | 'corrected';
export type FactStatus = 'pending' | 'confirmed';

export interface FactItem {
  id: string;
  kind: FactKind;
  /** 事实内容（中文短句，例如「明天下午三点」）。用户可改。 */
  value: string;
  /** 原话片段，**必须**是对应字幕的子串。 */
  sourceText: string;
  /** 片段取自哪个字段：原话还是译文。 */
  sourceField: 'original' | 'translation';
  /** 来源字幕 id（点击定位用）。 */
  itemId: string;
  /** 来源字幕是第几轮（排序 + 展示）。 */
  roundIndex: number;
  certainty: FactCertainty;
  status: FactStatus;
  /**
   * 这个值在原话里被明确否定了（「不是周二」「5万ではありません」）。
   *
   * 和 `certainty === 'corrected'` 的区别：`negated` 是**事实**（原话确实否了），
   * `corrected` 是**展示用的状态**（卡片上标「已更正」）。日语值不能加「不是」
   * 这种中文前缀，只能靠这个字段让界面说清「这条是被否掉的旧值」。
   */
  negated?: boolean;
  /** 用户手动改过（界面要标「已修改」并保留来源）。 */
  edited?: boolean;
  /** 用户改之前的原值，用于「更正信息时保留来源和变更提示」。 */
  originalValue?: string;
  /**
   * 「这条**现在**该怎么说给对方听」——目标语言的当前说法。
   *
   * 原话（`sourceText`）永远不改，它是证据；用户把「15,000 美元」改成
   * 「16,000 美元」之后，句子里要念的必须是 16,000。所以这里单独存一份
   * 目标语言的说法：
   *  - 没改过值 → 就是 `sourceText`（不重复存，读的时候补齐）；
   *  - 改过、且能机械推导（数字 / 星期 / 时间点）→ 由 `deriveSpoken()` 算；
   *  - 改过、推不出来（换币种、换地点）→ 让用户自己填，填的字进这里。
   *
   * 只有用户填的才标 `spokenSource: 'user'`，界面要说清「这是你写的说法」。
   */
  spoken?: string;
  spokenSource?: 'user' | 'derived';
  createdAt: number;
  /** 用户点「确认」的时刻；未确认时为空。 */
  confirmedAt?: number;
  /** 修改 / 确认的时间线（只记动作与前后值，不记全文）。 */
  log?: FactLogEntry[];
}

export interface FactLogEntry {
  at: number;
  action: 'edited' | 'confirmed' | 'unconfirmed';
  /** 改之前 / 之后的值（只对 edited 有意义）。 */
  from?: string;
  to?: string;
}

/** 模型/规则产出的原始形态（还没分配 id、轮次等）。 */
export interface FactDraft {
  kind: FactKind;
  value: string;
  sourceText: string;
  sourceField: 'original' | 'translation';
  certainty: FactCertainty;
  negated?: boolean;
}

/** 原话里的「不确定」语气词。命中就整条标 uncertain，不猜。 */
const HEDGE_PATTERNS = [
  /可能/,
  /大概/,
  /也许/,
  /应该/,
  /不确定/,
  /差不多/,
  /\.{2,}$/,
  /\bmaybe\b/i,
  /\bprobably\b/i,
  /\bperhaps\b/i,
  /\bmight\b/i,
  /\bnot sure\b/i,
  /\bi think\b/i,
  /\bkind of\b/i,
  /наверн/i,
  /возможно/i,
  /может/i,
  /たぶん/,
  /かもしれ/,
  /おそらく/,
  /아마/,
  /것 같/,
];

/** 更正句式：「不是三点，是四点」「改成周五」「not Monday but Tuesday」。 */
const CORRECTION_PATTERNS = [
  /不是[^，,。]{1,24}[，,]\s*(?:是|而是)/,
  /改成|改为|应该是|其实是/,
  /\bnot\b[^,.]{1,30}\bbut\b/i,
  /\binstead\b/i,
  /改为|変更/,
  /아니라/,
];

export function looksHedged(text: string): boolean {
  return HEDGE_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksCorrected(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** 一句话的「确定程度」判定，规则和模型都用它兜底。 */
export function certaintyOf(text: string): FactCertainty {
  if (looksCorrected(text)) return 'corrected';
  if (looksHedged(text)) return 'uncertain';
  return 'stated';
}

// --------------------------------------------------------------------------- //
// 规则提取
// --------------------------------------------------------------------------- //

/**
 * 时间：数字型（14:30 / 3 pm / 3点半 / 3시 30분）。
 *
 * 中文的「三点」只在译文里出现，所以两个字段都要扫 —— 但记下是从哪个字段
 * 取到的，界面上才能说清「这句原话」到底在哪一行。
 */
const TIME_PATTERNS: RegExp[] = [
  /\b\d{1,2}[:：]\d{2}\b/g,
  // 「3 p.m.」「10:30 a.m.」带点的那种写法：只写 am|pm 会漏掉一多半英文口语转写。
  /*
   * 分隔符要收 `.`：语音识别的输出常把 10:30 写成 `10.30am`、`4.15pm`
   * （Whisper 实测就是这样）。旧写法只认 `:`，于是 `10.30am` 被切成
   * `30am` —— 卡片上写着「时间 30am」，比没有还糟。
   */
  /\b\d{1,2}(?:[:：.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi,
  /\b\d{1,2}\s*(?:am|pm)\b/gi,
  /(?:上午|下午|早上|晚上|中午|凌晨)?[一二三四五六七八九十两\d]{1,3}点(?:半|[一二三四五六七八九十\d]{1,2}分)?/g,
  /\b\d{1,2}時(?:半|\d{1,2}分)?/g,
  /\b\d{1,2}시(?:\s*\d{1,2}분)?/g,
];

/**
 * 日期：相对表达保留原样（「明天」不许被换算成具体日期 —— 那是编造）。
 *
 * 单独出现的 `Tuesday` 也必须认：「The meeting is not on Tuesday. It has
 * moved to Thursday…」这种句子是最典型的真实场景（时间被改期），而它恰恰
 * 不带 this / next 前缀 —— 旧规则只认 `this Tuesday` / `next Tuesday`，
 * 于是整句的日期一个都提不出来。
 */
const DATE_PATTERNS: RegExp[] = [
  /今[天日]|明[天日]|后[天日]|大后天|本?周[一二三四五六日天]|下周[一二三四五六日天]|这周|下个?月|这个月/g,
  /\b(?:today|tomorrow|tonight|this (?:mon|tues|wednes|thurs|fri|satur|sun)day|next (?:week|month|mon|tues|wednes|thurs|fri|satur|sun)day)\b/gi,
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/gi,
  /\b(?:сегодня|завтра|послезавтра)\b/gi,
  /\bв (?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\b/gi,
  /(?:今日|明日|明後日|来週|今週|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日|日曜日)/g,
  /(?:오늘|내일|모레|이번 주|다음 주|월요일|화요일|수요일|목요일|금요일|토요일|일요일)/g,
];

/**
 * 拼写出来的数量词：`fifteen thousand` / `fifty thousand`。
 *
 * 「The budget is fifteen thousand, not fifty thousand.」一个阿拉伯数字都没有。
 * 只靠 `\d` 的规则在这句话上一个字都提不出来，用户就只能看到空卡片 ——
 * 而金额恰恰是这种对话里最不能听错的东西。
 *
 * 限定「数字词 + 量级词」才匹配（`thousand` / `million` / `hundred`），
 * 避免把普通的 `one` / `two` 当成金额满天飞。
 */
const WORD_NUMBER_PATTERN =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?\s+(?:hundred|thousand|million)\b/gi;

/** 带货币的拼写金额：`fifteen thousand dollars`。 */
const WORD_MONEY_PATTERN =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?\s+(?:hundred|thousand|million)?\s*(?:dollars?|usd|euros?|rubles?|yuan|rmb)\b/gi;

/**
 * 句子本身在谈钱（预算 / 价格 / 费用…）。
 *
 * 「The budget is fifteen thousand, not fifty thousand.」里一个货币符号都没有，
 * 但这两条数字毫无疑问是金额 —— 空手进来的样例 3 就挂在这里：旧规则只把它
 * 当「数量」提出来，卡片上写「数量 一万五千」，读起来像在数人头。
 * 有这些词打底就按金额处理；没有的话仍然保守地算数量（「3 个」不是钱）。
 */
const MONEY_CONTEXT =
  /\b(budget|price|cost|fees?|salary|rent|invoice|quote|deposit|amount|payment|charge|bill|total|paid?|pay)\b|予算|価格|費用|料金|請求|給料|家賃|報酬|入金|支払|预算|費用/i;

/** 金额：必须带货币标记，避免把「3 个人」当钱。 */
const MONEY_PATTERNS: RegExp[] = [
  /[¥$€]\s?\d[\d,]*(?:\.\d+)?/g,
  /\d[\d,]*(?:\.\d+)?\s*(?:元|块|美元|欧元)/g,
  /\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|usd|rubles?|rub|yen|euros?)\b/gi,
  /\d[\d,]*\s*(?:円|원)/g,
  /*
   * 日语的量级写法：`1万5千` / `5万`。
   *
   * 日语口语里金额常常不带「円」（「予算は1万5千で」），而 0.6.0 只认
   * `数字 + 円`，于是「预算一万五，不是五万」的日语版本一张卡都提不出来 ——
   * 恰恰是这句话最需要核对。没有货币单位时由 MONEY_CONTEXT 兜底判断。
   */
  /\d+(?:万|千)[\d千百十]*/g,
  /*
   * 千分位数字：`15,000` / `1,250,000`。
   *
   * 语音识别的输出经常是「The budget is 15,000, not 50,000.」—— 没有货币符号、
   * 没有 dollars，只有逗号分组。旧规则一条金额都提不出来（实测三组样例里第三组
   * 就这样整条空掉）。带千分位的写法几乎不可能是别的东西，直接按金额算。
   */
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g,
];

/** 数量（不含金额）：个 / 份 / people / pages… */
const QUANTITY_PATTERNS: RegExp[] = [
  /\d[\d,]*\s*(?:个|份|件|张|本|人|台|套|箱)/g,
  /\b\d[\d,]*\s*(?:people|persons?|copies|pages?|items?|boxes|copies)\b/gi,
  /\d[\d,]*\s*(?:명|개|장|권)/g,
];

/**
 * 否定标记：紧贴在某个值前面的「不是 / not」。
 *
 * 两点克制（都是实测撞出来的）：
 *  1. **不把「改成 / 改为」算成否定词** —— 它们后面跟的是更正后的新值，
 *     「改到周四」里的周四不是被否掉的那个；
 *  2. **不跨逗号** —— 「会议不在周二，改到周四」里，隔着逗号的周四不能被
 *     前半句的「不在」带歪（同一句里改期和否定经常一起出现）。
 */
const NEGATION_BEFORE =
  /(?:\bnot\b|\bno longer\b|\bisn't\b|\baren't\b|不是|不用|不在)[^.!?。！？；;，,、]{0,16}$/i;

/**
 * 日语把否定放在值**后面**：「5万ではありません」。
 *
 * 只看前面的规则会把「5万」当成一个确定的金额 —— 而这正是最容易听错的地方。
 * 限定不跨逗号、顿号（`、`/`，`）：`1万5千で、5万ではありません` 里前面的
 * 「1万5千」不能被后面那半句的否定带歪。
 */
const NEGATION_AFTER =
  /^[^。、，,！？]{0,6}(?:ではありません|じゃありません|ではない|じゃない|ではなく|じゃなく|は違います|違います)/;

/** 这个值在原句里是不是被否定的。 */
export function isNegatedValue(text: string, value: string): boolean {
  if (!value) return false;
  const haystack = text.toLowerCase();
  const needle = value.toLowerCase();
  let from = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = text.slice(Math.max(0, index - 20), index);
    if (NEGATION_BEFORE.test(before)) return true;
    const after = text.slice(index + value.length);
    if (NEGATION_AFTER.test(after)) return true;
    from = index + needle.length;
  }
  return false;
}


function matchAll(text: string, patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    // 全局正则带 lastIndex 状态，复用会漏匹配 —— 每次都新建一份。
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null = regex.exec(text);
    let guard = 0;
    while (match && guard < 50) {
      const value = match[0].trim();
      if (value) out.push(value);
      match = regex.exec(text);
      guard += 1;
    }
  }
  return out;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * 只靠规则就能定下来的事实。
 *
 * 返回的 `sourceField` 标出片段出自原话还是译文 —— 界面和校验都靠它。
 * 同一句话里相同的值只保留一次（中英文各匹配到「3 pm」不会出两张卡）。
 */
export function extractFactsWithRules(item: {
  originalText: string;
  translatedText?: string;
}): FactDraft[] {
  const fields: { field: 'original' | 'translation'; text: string }[] = [
    { field: 'original', text: item.originalText ?? '' },
  ];
  if (item.translatedText && item.translatedText.trim()) {
    fields.push({ field: 'translation', text: item.translatedText });
  }

  const drafts: FactDraft[] = [];
  const seen = new Set<string>();

  const push = (kind: FactKind, values: string[], field: 'original' | 'translation', text: string) => {
    /*
     * 同一条时间会被两条规则同时命中：「10:30 a.m」既符合 `\d{1,2}:\d{2}`，
     * 也符合「数字 + am/pm」。两条都留下的话，卡片上一行「10:30」一行
     * 「10:30 a.m」，确认句里也会念两遍。规则是：短的那个被长的包含时丢掉。
     */
    const unique = values.filter(
      (value) =>
        !values.some(
          (other) =>
            other !== value &&
            other.length > value.length &&
            other.toLowerCase().includes(value.toLowerCase()),
        ),
    );
    for (const value of unique) {
      /*
       * 被否定的值：标 `corrected` + `negated`，界面能直接读出纠正关系。
       *
       * 这里**按值**判断，不再按整句判断。旧写法是 `certaintyOf(text)` 先给
       * 整句定一个状态，于是「会議は…変更になりました」（含「変更」）这种句子
       * 会把**所有**值都标成「已更正」—— 连更正后的新时间都成了「已更正」，
       * 用户看到的是「周四也是错的」。
       */
      const negated = isNegatedValue(text, value);
      /*
       * 值本身不拼「不是」前缀。
       *
       * 前缀会写出「不是火曜日」「不是Tuesday」这种半中半外的东西，而这条
       * 事实要同时给中文用户和日语用户看。被否定这件事由 `negated` 字段带出去，
       * 界面用一句对应语言的话说「被否定」+ 划掉旧值，比在值里塞词干净。
       */
      const shown = value;
      const key = `${kind}|${shown.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      drafts.push({
        kind,
        value: shown,
        sourceText: value,
        sourceField: field,
        certainty: negated ? 'corrected' : looksHedged(text) ? 'uncertain' : 'stated',
        negated: negated || undefined,
      });
    }
  };

  for (const { field, text } of fields) {
    push('money', matchAll(text, MONEY_PATTERNS), field, text);
    // 拼写金额（fifteen thousand dollars）要在数量之前跑：它更具体，先占住位置。
    const wordMoney = matchAll(text, [WORD_MONEY_PATTERN]);
    push('money', wordMoney, field, text);
    /*
     * 不带货币单位的拼写数字（fifteen thousand）归哪一类，看句子在不在谈钱。
     *
     * 先剔掉已经被「带货币」那条吃走的部分，否则
     * `fifteen thousand dollars` 会同时产出「金额：fifteen thousand dollars」
     * 和「数量：fifteen thousand」两张卡，同一件事出现两遍。
     */
    const spelled = matchAll(text, [WORD_NUMBER_PATTERN]).filter(
      (value) => !wordMoney.some((money) => money.toLowerCase().includes(value.toLowerCase())),
    );
    push(MONEY_CONTEXT.test(text) ? 'money' : 'quantity', spelled, field, text);
    // 时间要在日期之前跑：「下周三点」这种说法很少见，但「明天三点」很常见，
    // 两边都命中时用户看到的是两条不同的卡（日期 + 时间），这是对的。
    push('time', matchAll(text, TIME_PATTERNS), field, text);
    push('date', matchAll(text, DATE_PATTERNS), field, text);
    push('quantity', matchAll(text, QUANTITY_PATTERNS), field, text);
  }

  return mergeBilingual(drafts);
}

/**
 * 把「原文一条 + 译文一条」的同一件事合成一条卡。
 *
 * 没有这一步，用户看到的是
 *     日期  明天      「明天」   · 译文中
 *     日期  Tomorrow  「Tomorrow」
 * ——同一件事两行，而且中文那行的「原文片段」还是中文，等于原文没露出来。
 *
 * 合成之后是
 *     日期  明天      「Tomorrow」 · 译文中
 * 也就是要求里的「简短中文标签 + 外语原文」：值取译文（中文可读），
 * 片段取原文（能核对对方到底怎么说的）。
 *
 * 只在同类事实数量对得上时才配对；多出来的原样保留，绝不硬凑。
 */
function mergeBilingual(drafts: FactDraft[]): FactDraft[] {
  const byKind = new Map<FactKind, { zh: FactDraft[]; src: FactDraft[] }>();
  for (const draft of drafts) {
    let bucket = byKind.get(draft.kind);
    if (!bucket) {
      bucket = { zh: [], src: [] };
      byKind.set(draft.kind, bucket);
    }
    if (draft.sourceField === 'translation') bucket.zh.push(draft);
    else bucket.src.push(draft);
  }

  const merged = new Map<FactDraft, FactDraft>();
  const consumed = new Set<FactDraft>();
  for (const bucket of byKind.values()) {
    const pairs = Math.min(bucket.zh.length, bucket.src.length);
    for (let index = 0; index < pairs; index += 1) {
      const zh = bucket.zh[index];
      const src = bucket.src[index];
      /*
       * 否定信息**两边都要看**。
       *
       * 「The meeting is not on Tuesday. It has moved to Thursday」里，否定标在
       * 英文原话上；中文译文那句是「会议不在周二」，两条规则都可能命中。
       * 旧代码直接 `{...zh}` 取值，等于把原文侧的 `corrected` 丢掉 ——
       * 合并之后周二成了一条中性的日期卡，正好和用户会记反的那件事重合。
       */
      const negated = Boolean(zh.negated || src.negated);
      merged.set(zh, {
        ...zh,
        sourceText: src.sourceText,
        negated: negated || undefined,
        certainty: negated
          ? 'corrected'
          : zh.certainty === 'uncertain' || src.certainty === 'uncertain'
            ? 'uncertain'
            : zh.certainty,
      });
      consumed.add(src);
    }
  }
  if (!merged.size) return drafts;
  return drafts
    .filter((draft) => !consumed.has(draft))
    .map((draft) => merged.get(draft) ?? draft);
}

// --------------------------------------------------------------------------- //
// 校验（模型输出必须过这一关）
// --------------------------------------------------------------------------- //

export interface FactSourceText {
  itemId: string;
  originalText: string;
  translatedText?: string;
  roundIndex: number;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 把一批「候选事实」校成可上屏的事实。
 *
 * 丢弃规则（全部是审计要求）：类型不认识、值为空、片段为空、
 * **片段在字幕里找不到**、长度离谱。
 */
export function validateFacts(
  candidates: unknown[],
  source: FactSourceText,
  makeId: (index: number) => string,
): FactItem[] {
  const original = normalize(source.originalText ?? '');
  const translation = normalize(source.translatedText ?? '');
  const out: FactItem[] = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;

    const kind = candidate.kind;
    if (typeof kind !== 'string' || !(FACT_KINDS as readonly string[]).includes(kind)) continue;

    const value = typeof candidate.value === 'string' ? candidate.value.trim() : '';
    const sourceText = typeof candidate.sourceText === 'string' ? candidate.sourceText.trim() : '';
    if (!value || !sourceText) continue;
    // 太长的多半是模型把整句话抄回来了，上屏也没法看。
    if (value.length > 60 || sourceText.length > 120) continue;

    const needle = normalize(sourceText);
    if (!needle) continue;
    let field: 'original' | 'translation' | null = null;
    if (original.includes(needle)) field = 'original';
    else if (translation.includes(needle)) field = 'translation';
    // 找不到出处 → 这条是模型编的，不要。
    if (!field) continue;

    const dedupeKey = `${kind}|${normalize(value)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const certainty =
      candidate.certainty === 'uncertain' || candidate.certainty === 'corrected'
        ? (candidate.certainty as FactCertainty)
        : certaintyOf(sourceText);

    out.push({
      id: makeId(out.length),
      kind: kind as FactKind,
      value,
      sourceText,
      sourceField: field,
      itemId: source.itemId,
      roundIndex: source.roundIndex,
      certainty,
      status: 'pending',
      createdAt: Date.now(),
    });
  }

  return out;
}

/** 界面上的状态词。有疑问的一律「待核对」，不给百分比。 */
export function factStatusLabel(fact: FactItem): string {
  if (fact.status === 'confirmed') return '已确认';
  // 被否定的旧值优先说「被否定」：它是用户最容易记反的那一条。
  if (fact.negated) return '被否定';
  if (fact.certainty === 'uncertain') return '待核对';
  if (fact.certainty === 'corrected') return '已更正';
  return '待确认';
}

/**
 * 不靠模型，直接用用户勾选的事实拼一句确认话。。
 *
 * 为什么要有这条本地路径：
 *  1. 演示模式下没有真实模型（mock 返回的不是 JSON），「帮我确认」会直接失败；
 *  2. 更重要 —— 确认句是**要对着别人念出来的**，模型多写一个数字就是一次事故。
 *     本地拼接只用「原话片段」，一个字符都不额外生成。
 *
 * 句子用目标语言（对方听得懂），释义用理解语言（用户自己看得懂）。
 * 被否定的旧值不进句子 —— 用户要确认的是「现在理解成什么」，不是把
 * 已经作废的周二再说一遍。
 */
/**
 * 拼确认句时用到的最小事实形状。
 *
 * 故意放宽成可选字段：单测会直接传普通对象进来，而界面传的是完整
 * `FactItem`。两者都能用，不要求调用方补一堆无关字段。
 */
export interface ConfirmInput {
  id?: string;
  kind?: string;
  value: string;
  sourceText: string;
  edited?: boolean;
  originalValue?: string;
  spoken?: string;
  spokenSource?: 'user' | 'derived';
  negated?: boolean;
  certainty?: string;
}

export type SpokenBlockReason = 'number' | 'currency' | 'time' | 'derive';

export interface SpokenBlocked {
  id: string;
  kind: string;
  value: string;
  sourceText: string;
  reason: SpokenBlockReason;
}

export interface ConfirmPlan {
  ok: boolean;
  sentence: string;
  meaning: string;
  blocked: SpokenBlocked[];
  message?: string;
}

/* ------------------------------------------------------------------------- */
/* 解析：数字 / 时间点 / 星期                                                 */
/* ------------------------------------------------------------------------- */

const ZH_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「十五」「二十」「3」都能读成数字；读不出就返回 null（宁可不猜）。 */
function zhNumber(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const ten = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(token);
  if (ten) return (ten[1] ? ZH_DIGITS[ten[1]] : 1) * 10 + (ten[2] ? ZH_DIGITS[ten[2]] : 0);
  if (token.length === 1 && token in ZH_DIGITS) return ZH_DIGITS[token];
  return null;
}

/**
 * 文本里的数值（理解为数字，不是字符串）。
 *
 * 必须归一化：`15,000` / `15000` / `1.5万` 指的是同一个数。上一版按字符串
 * 比较，用户把 15000 改成 16000 时「有没有新增数字」的检查形同虚设。
 */
export function valueNumbers(text: string): number[] {
  const out: number[] = [];
  if (!text) return out;
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(亿|万|千)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    let value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (match[2] === '亿') value *= 1e8;
    else if (match[2] === '万') value *= 1e4;
    else if (match[2] === '千') value *= 1e3;
    out.push(Math.round(value * 1e6) / 1e6);
  }
  return out;
}

interface Clock {
  /** 24 小时制。 */
  hour: number;
  minute: number;
}

/** 从一句话里认出一个时间点（10:30 / 下午三点 / 3 p.m. / 午後3時）。 */
function clockIn(text: string): Clock | null {
  if (!text) return null;
  const hm = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
  if (hm) {
    let hour = Number(hm[1]);
    const minute = Number(hm[2]);
    if (hm[3] && /p/i.test(hm[3]) && hour < 12) hour += 12;
    if (hm[3] && /a/i.test(hm[3]) && hour === 12) hour = 0;
    return { hour, minute };
  }
  const zh = /(上午|早上|凌晨|中午|下午|晚上)?\s*([0-9一二两三四五六七八九十]{1,3})\s*[点时](半|[0-9]{1,2}\s*分?)?/.exec(
    text,
  );
  if (zh) {
    const n = zhNumber(zh[2]);
    if (n == null) return null;
    const mark = zh[1] ?? '';
    let hour = n;
    if ((mark === '下午' || mark === '晚上') && hour < 12) hour += 12;
    if (mark === '中午' && hour < 12) hour = 12;
    if (mark === '凌晨' && hour === 12) hour = 0;
    const minute = zh[3] === '半' ? 30 : zh[3] ? Number(zh[3].replace(/[^\d]/g, '') || 0) : 0;
    return { hour, minute };
  }
  const en = /(\d{1,2})(?::(\d{2}))?\s*(o'?clock|a\.?m\.?|p\.?m\.?)/i.exec(text);
  if (en) {
    let hour = Number(en[1]);
    const minute = en[2] ? Number(en[2]) : 0;
    if (/p/i.test(en[3]) && hour < 12) hour += 12;
    if (/a/i.test(en[3]) && hour === 12) hour = 0;
    return { hour, minute };
  }
  const ja = /(午前|午後)?\s*(\d{1,2})\s*時(半|\d{1,2}\s*分)?/.exec(text);
  if (ja) {
    let hour = Number(ja[2]);
    if (ja[1] === '午後' && hour < 12) hour += 12;
    const minute = ja[3] === '半' ? 30 : ja[3] ? Number(ja[3].replace(/[^\d]/g, '') || 0) : 0;
    return { hour, minute };
  }
  return null;
}

/** 把原话里的时间点换成新值（保留 12/24 小时制风格）。 */
function replaceClock(source: string, next: Clock): string | null {
  const hm = /(\d{1,2}):(\d{2})/.exec(source);
  if (hm) {
    const mm = String(next.minute).padStart(2, '0');
    return `${source.slice(0, hm.index)}${next.hour}:${mm}${source.slice(hm.index + hm[0].length)}`;
  }
  const nums = [...source.matchAll(/\d{1,2}/g)];
  if (!nums.length) return null;
  const old12 = (hour: number) => (hour % 12 === 0 ? 12 : hour % 12);
  // 原话可能是 24 小时制（18:00 已处理）也可能是 12 小时制（3 p.m.）。
  const candidates = nums.filter((m) => Number(m[0]) <= 24);
  const picked =
    candidates.find((m) => Number(m[0]) === next.hour) ??
    candidates[candidates.length - 1];
  if (!picked || picked.index == null) return null;
  // 12 小时制就写 12 小时的值，24 小时制保留 24 小时的值。
  const writing24 = Number(picked[0]) > 12;
  const shown = writing24 ? next.hour : old12(next.hour);
  let out = `${source.slice(0, picked.index)}${shown}${source.slice(picked.index + picked[0].length)}`;

  const wantPm = next.hour >= 12;
  out = out.replace(/(上午|早上|凌晨|中午|下午|晚上)/, (all) => {
    if (wantPm) return all === '中午' ? '中午' : all === '晚上' ? '晚上' : '下午';
    return all === '凌晨' ? '凌晨' : '上午';
  });
  out = out.replace(/([ap])\.?m\.?/gi, (all) => {
    const dotted = all.includes('.');
    const upper = all === all.toUpperCase();
    const base = wantPm ? 'pm' : 'am';
    const text = dotted ? `${base[0]}.${base[1]}.` : base;
    return upper ? text.toUpperCase() : text;
  });
  out = out.replace(/(午前|午後)/, () => (wantPm ? '午後' : '午前'));
  return out;
}

const EN_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const JA_DAYS = ['月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日', '日曜日'];
const ZH_DAY: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

/** 一句话里提到的星期（0=周一）。中 / 英 / 日三种写法都认。 */
export function weekdaysIn(text: string): number[] {
  const out: number[] = [];
  if (!text) return out;
  for (const match of text.matchAll(/(?:周|星期|礼拜)([一二三四五六日天])/g)) {
    const day = ZH_DAY[match[1]];
    if (day != null) out.push(day);
  }
  for (const match of text.matchAll(/([月火水木金土日])曜日?/g)) {
    const day = JA_DAYS.findIndex((name) => name.startsWith(match[1]));
    if (day >= 0) out.push(day);
  }
  for (const match of text.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)(day|sday|nesday|rsday|urday)?\b/gi)) {
    const head = match[1].toLowerCase();
    const day = EN_DAYS.findIndex((name) => name.startsWith(head));
    if (day >= 0) out.push(day);
  }
  return [...new Set(out)];
}

function matchCase(sample: string, word: string): string {
  if (sample === sample.toUpperCase()) return word.toUpperCase();
  if (sample[0] === sample[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

function replaceWeekday(source: string, from: number, to: number): string | null {
  const en = new RegExp(`\\b(${EN_DAYS[from]}|${EN_DAYS[from].slice(0, 3)}[a-z]*)\\b`, 'i');
  if (en.test(source)) return source.replace(en, (all) => matchCase(all, EN_DAYS[to]));
  if (source.includes(JA_DAYS[from])) return source.replace(JA_DAYS[from], JA_DAYS[to]);
  const zh = /(?:周|星期|礼拜)([一二三四五六日天])/;
  if (zh.test(source)) {
    const name = ['一', '二', '三', '四', '五', '六', '日'][to];
    return source.replace(zh, (all) => all.replace(/[一二三四五六日天]$/, name));
  }
  return null;
}

function replaceNumber(source: string, from: number, to: number): string | null {
  const tokens = [...source.matchAll(/\d[\d,]*(?:\.\d+)?/g)];
  const hit = tokens.find((token) => Math.round(Number(token[0].replace(/,/g, '')) * 1e6) / 1e6 === from);
  if (!hit || hit.index == null) return null;
  const formatted = hit[0].includes(',') ? to.toLocaleString('en-US') : String(to);
  return `${source.slice(0, hit.index)}${formatted}${source.slice(hit.index + hit[0].length)}`;
}

type Currency = 'USD' | 'JPY' | 'EUR' | 'CNY' | 'GBP';
const CURRENCY_WORDS: [Currency, RegExp][] = [
  ['USD', /美元|美金|dollars?|\bUSD\b|\$/i],
  ['JPY', /日元|日圆|日幣|yen|\bJPY\b|円/i],
  ['EUR', /欧元|euros?|\bEUR\b|€/i],
  ['GBP', /英镑|pounds?|\bGBP\b|£/i],
  ['CNY', /人民币|块钱|rmb|\bCNY\b|¥/i],
];

function currencyOf(text: string): Currency | null {
  for (const [code, pattern] of CURRENCY_WORDS) if (pattern.test(text)) return code;
  return null;
}

/* ------------------------------------------------------------------------- */
/* 推导「现在该怎么说」                                                       */
/* ------------------------------------------------------------------------- */

/**
 * 「这条现在该怎么念」。
 *
 * 原话是**证据**，永远不改；用户改过值之后，句子里要念的是改后的值。
 * 能机械推导的只有三类：时间点、星期、数值（含金额数字）。其余（换币种、
 * 换地点、整句重写）一律返回 blocked —— 让用户自己写一句目标语言的说法，
 * 而不是把旧英文配着新中文一起给出去。
 */
export function deriveSpoken(
  fact: ConfirmInput,
  targetLanguage: string,
): { ok: true; text: string; changed: boolean } | { ok: false; reason: SpokenBlockReason } {
  const source = (fact.sourceText ?? '').trim();
  const value = (fact.value ?? '').trim();
  const override = (fact.spoken ?? '').trim();

  if (override) {
    // 用户自己写的说法也要过数值闸：不能把旧值写回去。
    const need = valueNumbers(value);
    const have = new Set(valueNumbers(override));
    if (need.some((number) => !have.has(number))) return { ok: false, reason: 'number' };
    return { ok: true, text: override, changed: true };
  }
  if (!fact.edited || !value || !source) return { ok: true, text: source, changed: false };

  const oldValue = (fact.originalValue ?? '').trim();
  let text = source;
  let changed = false;

  const oldClock = clockIn(oldValue);
  const newClock = clockIn(value);
  if (oldClock && newClock && (oldClock.hour !== newClock.hour || oldClock.minute !== newClock.minute)) {
    const replaced = replaceClock(source, newClock);
    if (!replaced) return { ok: false, reason: 'time' };
    text = replaced;
    changed = true;
  }

  const oldDays = weekdaysIn(oldValue);
  const newDays = weekdaysIn(value);
  if (oldDays.length === 1 && newDays.length === 1 && oldDays[0] !== newDays[0]) {
    const replaced = replaceWeekday(text, oldDays[0], newDays[0]);
    if (!replaced) return { ok: false, reason: 'derive' };
    text = replaced;
    changed = true;
  }

  if (!changed) {
    const oldNums = valueNumbers(oldValue);
    const newNums = valueNumbers(value);
    if (oldNums.length === 1 && newNums.length === 1 && oldNums[0] !== newNums[0]) {
      const replaced = replaceNumber(text, oldNums[0], newNums[0]);
      if (!replaced) return { ok: false, reason: 'number' };
      text = replaced;
      changed = true;
    }
  }

  // 币种/单位变了就不能只换数字：「16,000 dollars」写成「15,000 日元」是错的。
  const wanted = currencyOf(value);
  const original = currencyOf(source);
  if (wanted && wanted !== original) return { ok: false, reason: 'currency' };

  switch (targetLanguage) {
    case 'English':
    case 'Japanese':
    case 'Chinese':
      break;
    default:
      // 别的目标语言这里没有词表，推导不出可信说法。
      if (!changed) return { ok: false, reason: 'derive' };
  }

  // 改过、却什么都没推导出来 → 不拿原话顶替。
  if (!changed) return { ok: false, reason: 'derive' };
  if (!valueNumbers(text).length && valueNumbers(value).length) return { ok: false, reason: 'number' };
  return { ok: true, text, changed };
}

function blockedMessage(blocked: SpokenBlocked[], targetLabel: string): string {
  const items = blocked
    .slice(0, 3)
    .map((item) => `「${item.value}」（原话「${item.sourceText}」）`)
    .join('、');
  return `有 ${blocked.length} 条改过的信息我没法可靠地换成${targetLabel}：${items}。点那一行的「改说法」，用${targetLabel}写一句现在要说的话 —— 我不拿旧说法顶上去。`;
}

const CONFIRM_SPOKEN: Record<string, { lead: string; tail: string }> = {
  English: { lead: 'Just to confirm, ', tail: '. Is that right?' },
  Japanese: { lead: '確認ですが、', tail: 'で合っていますか。' },
  Russian: { lead: 'Уточню: ', tail: '. Верно?' },
  Korean: { lead: '확인차 말씀드리면, ', tail: ' 맞나요?' },
};

const CONFIRM_MEANING: Record<string, { lead: string; tail: string }> = {
  Chinese: { lead: '我理解的是', tail: '，对吗？' },
  Japanese: { lead: '私の理解では、', tail: 'で合っていますか。' },
  English: { lead: 'I understand it as ', tail: '. Is that right?' },
  Russian: { lead: 'Я понял так: ', tail: '. Верно?' },
  Korean: { lead: '제가 이해한 바로는 ', tail: ' 맞나요?' },
};

const LANGUAGE_LABEL: Record<string, string> = {
  English: '英语', Japanese: '日语', Chinese: '中文', Russian: '俄语', Korean: '韩语',
};

function confirmJoiner(language: string): string {
  return language === 'Japanese' || language === 'Chinese' ? '、' : ', ';
}

/**
 * 最终闸门：句子 / 释义 里的数值与星期，必须和「当前理解」一致。
 *
 * 模型那条路也要过这一关 —— 它会很自然地把原话里的 15,000 抄回去，也会把
 * 「周四」写成 Tuesday。这里按数值比较（15,000 = 15000 = 1.5万），不看字符串。
 */
export function checkSentenceAgainstFacts(
  sentence: string,
  meaning: string,
  facts: ConfirmInput[],
): { ok: true } | { ok: false; message: string } {
  const required = new Set<number>();
  const stale = new Set<number>();
  const requiredDays = new Set<number>();
  const staleDays = new Set<number>();

  for (const fact of facts) {
    if (fact.negated) continue;
    for (const number of valueNumbers(fact.value)) required.add(number);
    for (const day of weekdaysIn(fact.value)) requiredDays.add(day);
    if (fact.edited) {
      for (const number of valueNumbers(fact.originalValue ?? '')) {
        if (!required.has(number)) stale.add(number);
      }
      for (const number of valueNumbers(fact.sourceText)) {
        if (!required.has(number)) stale.add(number);
      }
      for (const day of weekdaysIn(fact.originalValue ?? '')) {
        if (!requiredDays.has(day)) staleDays.add(day);
      }
    }
  }

  const said = valueNumbers(sentence);
  const saidSet = new Set(said);
  const missing = [...required].filter((number) => !saidSet.has(number));
  if (missing.length) {
    return { ok: false, message: `这句话里没有你改后的数值（${missing.join('、')}），不能给对方看` };
  }
  const leftover = said.filter((number) => stale.has(number));
  if (leftover.length) {
    return { ok: false, message: `这句话里还留着你改之前的旧数值（${leftover.join('、')}），已拦下` };
  }

  const saidDays = weekdaysIn(sentence);
  if ([...requiredDays].some((day) => !saidDays.includes(day))) {
    return { ok: false, message: '这句话里没有说到你改后的星期，已拦下' };
  }
  if (saidDays.some((day) => staleDays.has(day))) {
    return { ok: false, message: '这句话里还留着你改之前的星期，已拦下' };
  }

  const meaningNumbers = new Set(valueNumbers(meaning));
  const meaningMissing = [...required].filter((number) => !meaningNumbers.has(number));
  if (meaningMissing.length) {
    return { ok: false, message: '释义和改后的数值对不上，已拦下' };
  }
  return { ok: true };
}

/**
 * 生成确认句的完整计划：句子、释义、以及「哪几条卡住了、为什么」。
 *
 * 句子用目标语言（对方听得懂），释义用理解语言（用户自己看得懂）——
 * 两者都从**当前理解**出发，不再一个用原话、一个用改后的值。
 */
export function planConfirmSentence(
  facts: ConfirmInput[],
  targetLanguage: string,
  comprehension: string,
): ConfirmPlan {
  const current = facts.filter(
    /*
     * 只排除「被原话否定」的旧值。
     *
     * 不能顺手把 `certainty === 'corrected'` 也排除掉：模型那条路把
     * 「不是三点，是四点」的**四点**标成 corrected（取的是更正后的值），
     * 它恰恰是要确认的内容。旧代码两个条件一起写，等于把更正后的当前值
     * 整条扔掉，确认句直接变空。
     */
    (fact) => !fact.negated && fact.value.trim(),
  );
  if (!current.length) {
    return {
      ok: false,
      sentence: '',
      meaning: '',
      blocked: [],
      message: '选中的都是已作废的旧值，没有可确认的内容；换一条「当前理解」再试。',
    };
  }

  const blocked: SpokenBlocked[] = [];
  const spoken: string[] = [];
  const understood: string[] = [];
  for (const fact of current.slice(0, 4)) {
    const derived = deriveSpoken(fact, targetLanguage);
    if (!derived.ok) {
      blocked.push({
        id: fact.id ?? '',
        kind: fact.kind ?? '',
        value: fact.value,
        sourceText: fact.sourceText,
        reason: derived.reason,
      });
      continue;
    }
    if (!spoken.includes(derived.text)) spoken.push(derived.text);
    if (!understood.includes(fact.value.trim())) understood.push(fact.value.trim());
  }

  if (blocked.length) {
    const label = LANGUAGE_LABEL[targetLanguage] ?? targetLanguage;
    return { ok: false, sentence: '', meaning: '', blocked, message: blockedMessage(blocked, label) };
  }
  if (!spoken.length) {
    return { ok: false, sentence: '', meaning: '', blocked: [], message: '这些信息拼不成一句话，换几条再试' };
  }

  const spokenTpl = CONFIRM_SPOKEN[targetLanguage] ?? CONFIRM_SPOKEN.English;
  const meaningTpl = CONFIRM_MEANING[comprehension] ?? CONFIRM_MEANING.Chinese;
  /*
   * 尾巴别和最后一段叠成两个句号。
   * 「tomorrow at 3 p.m.」+「. Is that right?」念出来是 "p.m.. Is that right?"，
   * 复制给别人看也难看。
   */
  const joinTail = (last: string, tail: string): string =>
    /[.!?]$/.test(last.trim()) && /^[.!?]/.test(tail) ? tail.slice(1) : tail;
  const sentence = `${spokenTpl.lead}${spoken.join(confirmJoiner(targetLanguage))}${joinTail(spoken[spoken.length - 1], spokenTpl.tail)}`;
  const meaning = `${meaningTpl.lead}${understood.join(confirmJoiner(comprehension))}${joinTail(understood[understood.length - 1], meaningTpl.tail)}`;

  const check = checkSentenceAgainstFacts(sentence, meaning, current);
  if (!check.ok) return { ok: false, sentence: '', meaning: '', blocked: [], message: check.message };
  return { ok: true, sentence, meaning, blocked: [] };
}

/** 兼容旧调用：能拼就返回，拼不出（或不可靠）就 null。 */
export function buildConfirmSentence(
  facts: ConfirmInput[],
  targetLanguage: string,
  comprehension: string,
): { sentence: string; meaning: string } | null {
  const plan = planConfirmSentence(facts, targetLanguage, comprehension);
  return plan.ok ? { sentence: plan.sentence, meaning: plan.meaning } : null;
}

/**
 * 生成确认句之前的一道闸：句子里的数字必须来自「选中的事实」。
 *
 * 模型很容易顺手补一句「需要三个人参加」——那是**新的承诺**，用户说出来
 * 就把自己坑了。数字是最容易被编进去的具体信息，所以拿它做硬校验。
 */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).map((value) => value.replace(/[,\s]/g, ''));
}

export function introducesNewNumbers(sentence: string, factsText: string): boolean {
  const allowed = new Set(numbersIn(factsText));
  return numbersIn(sentence).some((value) => !allowed.has(value));
}

/**
 * 选中若干事实 → 给模型看的一行行文本（顺序即用户看到的顺序）。
 *
 * 必须把**关系**一起给出去：只给两行「周二」「周四」，模型分不清哪个是
 * 被否掉的旧值，很容易把周二写回确认句。改过的行也要写清前后值。
 */
export function factsForConfirm(facts: ConfirmInput[]): string {
  return facts
    .map((fact) => {
      const parts = [`- ${FACT_LABELS[fact.kind as FactKind] ?? fact.kind}：${fact.value}`];
      parts.push(`原话「${fact.sourceText}」`);
      if (fact.negated) parts.push('状态：被原话否定，不成立，**不许写进确认句**');
      else if (fact.certainty === 'corrected') parts.push('状态：已更正');
      else if (fact.certainty === 'uncertain') parts.push('状态：待核对');
      if (fact.edited && fact.originalValue) {
        parts.push(`用户已把「${fact.originalValue}」改成「${fact.value}」，确认句必须用改后的值`);
      }
      if (fact.spoken) parts.push(`现在要对对方说的说法：「${fact.spoken}」`);
      return parts.join('｜');
    })
    .join('\n');
}
