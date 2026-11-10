/**
 * 原文 ↔ 译文的关键信息一致性检查。
 *
 * 为什么需要这个文件：
 *
 * 实测（0.7.0-web，本地 Opus-MT 量化模型）：
 *   输入 `The budget is twelve thousand, not twenty thousand.`
 *   输出 `预算为12 000,而不是2 000。`
 *
 * `twenty thousand` 是 20000，译文写成 2000 —— 少了一个零。听障使用者读到
 * 「两千」，会照着这个数去谈钱。这不是「翻译不太准」，是会让人亏钱的错误。
 *
 * 这类错误靠「再训一个好模型」短期解决不了，也不能把这一句写死。能做而且
 * 该做的是三层：
 *   1. 把原文的数值 / 时间 / 星期 / 否定关系**规范化**成可比的东西；
 *   2. 在译文里找同样的东西，逐项比对，指出「这个数原文里没有」「原文有的
 *      这个数译文没出现」；
 *   3. 对不上就**明确告诉用户去核对原文**，而不是假装译文可信。
 *
 * 事实卡永远从**原文**提取，译文只是辅助 —— 这一条是整个设计的底线：
 * 译文全错，用户按原文核对仍然能拿到对的数。
 *
 * 本文件不依赖任何平台 API，桌面端与网页端共用。
 */

/* ------------------------------------------------------------------------- */
/* 基础词表                                                                    */
/* ------------------------------------------------------------------------- */

const EN_UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const EN_SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };

const EN_UNIT_ALT = Object.keys(EN_UNITS).join('|');
/** 「数词 + 量级」：`twelve thousand` / `twenty five thousand` / `one hundred`。 */
const EN_WORD_NUMBER = new RegExp(
  `\\b((?:${EN_UNIT_ALT})(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?)\\s+(hundred|thousand|million|billion)\\b`,
  'gi',
);
/** 「数词 + hundred + and + 数词」：`one hundred and fifty`。 */
const EN_HUNDRED_AND = new RegExp(
  `\\b(?:${EN_UNIT_ALT})\\s+hundred\\s+and\\s+(?:${EN_UNIT_ALT})\\b`,
  'gi',
);
/** 冠词当数词：`a hundred` / `a thousand`。 */
const EN_A_SCALE = /\b(a|an)\s+(hundred|thousand|million|billion)\b/gi;
/** `forty-five` / `twenty five`。 */
const EN_BARE_TENS =
  /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\s](one|two|three|four|five|six|seven|eight|nine)\b/gi;
/** 单独一个数词（含 `two` 这种没有量级词的）。 */
const EN_BARE_UNIT =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/gi;

/**
 * `one` 是数量还是代词。
 *
 * 「one of them」「no one」「each one」里的 one 指人/物，不是 1；把它当数字
 * 会让译文平白多一条「原文的 1 没出现」。这里只看紧邻的上下文，不做语法分析。
 */
function isPronounOne(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index).toLowerCase();
  if (/\b(no|any|every|some|each|this|that|which|the other|another)\s+$/.test(before)) return true;
  const after = text.slice(index + 3, index + 20).toLowerCase();
  if (/^\s+(of|another|day|thing|more|or|time|way|side|hand|and the other)\b/.test(after)) return true;
  return false;
}


const ZH_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4,
  五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9,
};

const ZH_UNIT: Record<string, number> = {
  十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8,
};

const EN_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * 中文星期。用「周X / 星期X / 礼拜X」三种写法，不含「明天」这类相对表达 ——
 * 「明天」是相对日期，换算成星期几要依赖今天的日期，属于编造。
 */
const ZH_WEEKDAY = /(?:周|週|星期|礼拜)([一二三四五六日天])/g;

/* ------------------------------------------------------------------------- */
/* 数据结构                                                                    */
/* ------------------------------------------------------------------------- */

export interface NumberHit {
  /** 归一化后的数值，用来比较；`1.5万` 记 15000。 */
  value: number;
  /** 原文里长什么样，报错时要给人看原文。 */
  raw: string;
  /**
   * 在文本里的位置。
   *
   * 必须记位置，不能事后 `indexOf`：`预算为12 000,而不是2 000` 里
   * `indexOf('2 000')` 会命中 `12 000` 的尾部，于是「而不是」被当成
   * 修饰 `12 000` 的否定词，整个否定关系判反。
   */
  start: number;
  end: number;
}

export interface TimeHit {
  /** 24 小时制。下午 2 点记 14。 */
  hour: number;
  minute: number;
  raw: string;
  start: number;
  end: number;
  /**
   * 字面没写明上午还是下午（ASR 常把 4:20 写成 `4.20` 又丢掉 am/pm）。
   *
   * 这种写法不能擅自 +12 当成下午，也不能硬说成「凌晨4点20分」去和译文
   * 报冲突 —— 只能提醒使用者向对方确认。`scanNumbers` 仍然会用它占住 span，
   * 免得 `4.20` 又被当成小数金额。
   */
  ambiguous?: boolean;
}

export interface DayHit {
  /** 0 = 周一。 */
  day: number;
  raw: string;
}

export type CheckLevel = 'ok' | 'warn';

/** 时间方向：`提前` / `延后`。方向错了会让人早到或晚到，比数值错更直接。 */
export type Direction = 'earlier' | 'later';

export interface NumericCheck {
  level: CheckLevel;
  numbers: { source: NumberHit[]; target: NumberHit[]; missing: NumberHit[]; unsourced: NumberHit[] };
  times: { source: TimeHit[]; target: TimeHit[]; missing: TimeHit[]; unsourced: TimeHit[] };
  days: { source: DayHit[]; target: DayHit[]; missing: DayHit[]; unsourced: DayHit[] };
  /** 原文被否定的数值在译文里是否也被否定（`not twenty thousand` → `而不是2 000`）。 */
  negation: { source: number[]; target: number[]; ok: boolean };
  /**
   * 时间方向。
   *
   * `targetExtra` 是译文里有、原文里没有的方向词 —— 实测 `Please move the
   * meeting to Friday at 2 p.m.` 被译成「请将会议**提前**至星期五下午2时」，
   * 原文只说了改期，没说提前还是延后。照着「提前」行动会早到。
   */
  direction: { source: Direction[]; target: Direction[]; targetExtra: Direction[] };
  /** 直接能显示给用户的一句话；ok 时为空串。 */
  message: string;
}

/* ------------------------------------------------------------------------- */
/* 中文数字 → 数值                                                             */
/* ------------------------------------------------------------------------- */

/**
 * 「一万五千」「两万」「1万5千」「十二万」→ 数值。
 *
 * 允许阿拉伯数字与汉字混写，因为译文的实际输出就是这样（`12 000` 和
 * `一万五千` 会同时出现）。解析不了返回 null —— 宁可漏掉一个数，也不要
 * 猜一个数出来，猜错比漏掉更危险。
 */
export function chineseNumeralToValue(token: string): number | null {
  if (!token) return null;
  let total = 0;
  let section = 0;
  let num = 0;
  let seen = false;
  let lastUnit = 0;

  for (const ch of token) {
    if (ch >= '0' && ch <= '9') {
      num = num * 10 + Number(ch);
      seen = true;
      continue;
    }
    if (ch in ZH_DIGIT) {
      num = ZH_DIGIT[ch];
      seen = true;
      continue;
    }
    if (ch in ZH_UNIT) {
      const unit = ZH_UNIT[ch];
      seen = true;
      if (unit === 1e4 || unit === 1e8) {
        // 大单位：把当前 section 结账上卷。
        const carry = section + num;
        total += (carry === 0 ? 1 : carry) * unit;
        section = 0;
        num = 0;
      } else {
        // 小单位：`十` 前面没数就是 1（「十五」= 15）。
        const carry = num === 0 && unit === 10 ? 1 : num;
        section += (carry === 0 ? 1 : carry) * unit;
        num = 0;
      }
      lastUnit = unit;
      continue;
    }
    // 出现别的字符（`元`/`块`/空格）就到此为止，前面的算数。
    if (seen) break;
    return null;
  }

  if (!seen) return null;
  // 「一万二」这种省略末位单位的写法不猜：`lastUnit === 1e4` 且 num < 10000 时
  // 口语指「一万二千」，但也可能是「一万零二」。这里只把 num 原样加上，
  // 得到 10002，宁可对不上触发核对，也不凭空补一个千位。
  return total + section + num;
}

/* ------------------------------------------------------------------------- */
/* 扫描器                                                                      */
/* ------------------------------------------------------------------------- */

/** 空格 / 逗号 / 全角逗号 都能当千分位分隔符；译文里 `12 000` 很常见。 */
function readArabicRun(text: string, start: number): { value: number; end: number } | null {
  let i = start;
  let digits = '';
  let groups = 0;
  // 首段 1–3 位
  while (i < text.length && text[i] >= '0' && text[i] <= '9' && digits.length < 15) {
    digits += text[i];
    i += 1;
  }
  if (!digits) return null;
  // 后续 `, 000` / ` 000` 分组
  for (let guard = 0; guard < 6; guard += 1) {
    const sep = text[i];
    if (sep !== ',' && sep !== '，' && sep !== ' ' && sep !== '\u00A0' && sep !== '\u202F') break;
    let j = i + 1;
    let group = '';
    while (j < text.length && text[j] >= '0' && text[j] <= '9' && group.length < 3) {
      group += text[j];
      j += 1;
    }
    // 必须是完整三位分组，否则不算千分位（`12 000` 是，`12 3` 不是）
    if (group.length !== 3) break;
    // 空格分隔还要求后面不是新的数字串（防把「2 个 300 元」并成一个数）
    if ((sep === ' ' || sep === '\u00A0' || sep === '\u202F') && /^\d/.test(text.slice(j, j + 1))) break;
    digits += group;
    groups += 1;
    i = j;
  }
  // 小数
  if (text[i] === '.') {
    let j = i + 1;
    let frac = '';
    while (j < text.length && text[j] >= '0' && text[j] <= '9' && frac.length < 6) {
      frac += text[j];
      j += 1;
    }
    if (frac) {
      digits += `.${frac}`;
      i = j;
    }
  }
  // 单独一个数字串后面跟「万/千/亿」要交给中文数字解析（`1万5千`）
  void groups;
  const value = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return { value, end: i };
}

/**
 * 英语口语数词 → 数值，只用于**时间点**（0–59）。
 *
 * `four twenty` 里的 twenty 是分钟、`oh five` 里的 five 是分钟 —— ASR 常把
 * `4:20` 直接写成这两个词并丢掉冒号与 am/pm。只认 0–59 的封闭数词表；
 * `hundred` / `thousand` 不在表里，读不出就返回 null，绝不猜一个时刻。
 */
function spokenNumberToValue(text: string): number | null {
  let value = 0;
  let seen = false;
  for (const word of text.toLowerCase().split(/[\s-]+/)) {
    if (!word) continue;
    if (word === 'oh' || word === 'o') {
      seen = true;
      continue;
    }
    const n = EN_UNITS[word];
    if (n === undefined) return null;
    value += n; // twenty + five = 25
    seen = true;
  }
  return seen ? value : null;
}

/** 「数词 数词 时段词」里的数词形态。 */
const EN_CLOCK_WORD =
  '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?';

/** 时间点：英文 `3 p.m.` / `10.30am`，中文 `下午2时` / `14:30` / `上午十点`。 */
export function scanTimes(text: string): { hits: TimeHit[]; spans: [number, number][] } {
  const hits: TimeHit[] = [];
  const spans: [number, number][] = [];

  const push = (hour: number, minute: number, raw: string, start: number, ambiguous = false) => {
    if (hour > 24 || minute > 59) return;
    hits.push({
      hour, minute, raw, start, end: start + raw.length,
      ...(ambiguous ? { ambiguous: true } : {}),
    });
    spans.push([start, start + raw.length]);
  };

  // 1) 带 am/pm 的英文写法必须**先**匹配。
  //    否则 `10:30 a.m.` 先被纯时刻规则吃掉 `10:30`，残留一个 `a.m.`
  //    在中文确认句里（实测就是 `上午10点30分 a.m.`）。
  //    冒号后允许有界空格：`4: 20 p.m.`（模型/输入常带空格）也要归成时间，
  //    不能漏成两个裸数字 4 和 20。
  const en = /(\d{1,2})(?:[:.]\s*(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
  let m: RegExpExecArray | null;
  while ((m = en.exec(text))) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const pm = /p/i.test(m[3]);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
    push(hour, minute, m[0], m.index);
  }

  /*
   * 1b) 英语口语拼写时间 + 时段词：`four twenty in the afternoon` /
   *     `ten thirty a.m.` / `nine oh five at night`。
   *
   * ASR 常把 `4:20 p.m.` 写成「four twenty」并丢掉冒号与 am/pm，只留下
   * afternoon 这类时段词。不认它，four / twenty 就会被 scanNumbers 当成两个
   * 金额数（4 和 20），一致性检查凭空报「原文有 4、20，译文没有」；下午
   * 4:20 也等于没读出来。这里整段占用 span，数值扫描器就不会再拆它，
   * 并统一归一化成 24 小时制（16:20），与 `4:20 p.m.` / `16:20` 等价。
   */
  const spokenClock = new RegExp(
    `\\b(${EN_CLOCK_WORD})\\s+((?:oh\\s+)?${EN_CLOCK_WORD})\\s+(?:(?:in\\s+the|at)\\s+)?(morning|afternoon|evening|night|a\\.?m\\.?|p\\.?m\\.?)(?![a-z])`,
    'gi',
  );
  while ((m = spokenClock.exec(text))) {
    const hour = spokenNumberToValue(m[1]);
    const minute = spokenNumberToValue(m[2]);
    if (hour == null || minute == null || hour < 1 || hour > 23 || minute > 59) continue;
    if (spans.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    const part = m[3].toLowerCase();
    const pm = /^(afternoon|evening|night|p)/.test(part);
    let h = hour;
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    push(h, minute, m[0], m.index);
  }

  /*
   * 1c) 数字时间 + 时段词：`4.20 in the afternoon` / `10:30 in the morning`。
   *
   * ASR 把 4:20 p.m. 的点号写法丢了 am/pm，只留 in the afternoon。没有时段词
   * 的裸 `4.20` 绝不擅自 +12，交给规则 3 标 ambiguous（不写成「凌晨4点20分」）。
   */
  const clockWithPart = /(\d{1,2})(?:[:：.]\s*(\d{2}))\s+(?:(?:in\s+the|at)\s+)?(morning|afternoon|evening|night)\b/gi;
  while ((m = clockWithPart.exec(text))) {
    if (spans.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const part = m[3].toLowerCase();
    const pm = part === 'afternoon' || part === 'evening' || part === 'night';
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
    push(hour, minute, m[0], m.index);
  }

  // 2) 中文 `下午2时` / `上午十点` / `下午2点30分` / `2时半`
  const zh = /(上午|早上|早晨|凌晨|中午|下午|晚上|傍晚)?\s*(\d{1,3}|[零一二两三四五六七八九十]{1,3})\s*[点时時](?:\s*(半|\d{1,2}\s*分?|[零一二三四五六七八九十]{1,2}\s*分))?/g;
  while ((m = zh.exec(text))) {
    const n = /^\d+$/.test(m[2]) ? Number(m[2]) : chineseNumeralToValue(m[2]);
    if (n == null || Number.isNaN(n)) continue;
    const mark = m[1] ?? '';
    let hour = n;
    if ((mark === '下午' || mark === '晚上' || mark === '傍晚') && hour < 12) hour += 12;
    if (mark === '中午' && hour < 12) hour = 12;
    if ((mark === '凌晨' || mark === '早上' || mark === '早晨' || mark === '上午') && hour === 12) hour = 0;
    let minute = 0;
    if (m[3] === '半') minute = 30;
    else if (m[3]) {
      const digits = m[3].replace(/[^\d]/g, '');
      minute = digits ? Number(digits) : (chineseNumeralToValue(m[3].replace(/分/g, '')) ?? 0);
    }
    if (minute > 59) continue;
    if (spans.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    push(hour, minute, m[0], m.index);
  }

  // 2b) 中文时段词 + 冒号时刻：`下午4: 20` / `下午4:20` / `晚上10: 30`。
  //     中文的「下午」修饰的是**冒号写法**的时刻，不是「点/时」写法。
  //     `下午4点20分` 已被规则 2 吃掉；这里专接冒号（含全角）写法的时刻，
  //     冒号后允许有界空格（`4: 20`），把「下午 4:20」归成 16:20，
  //     而不是让 4 和 20 漏成两个裸数字。时段词只作用于紧邻的局部时刻，
  //     不因全文出现「下午」就给所有时刻 +12。
  const zhClock = /(上午|早上|早晨|凌晨|中午|下午|晚上|傍晚)\s*(\d{1,2})[:：]\s*(\d{1,2})(?!\d)/g;
  while ((m = zhClock.exec(text))) {
    if (spans.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    let hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour > 24 || minute > 59) continue;
    const mark = m[1];
    if ((mark === '下午' || mark === '晚上' || mark === '傍晚') && hour < 12) hour += 12;
    if (mark === '中午' && hour < 12) hour = 12;
    if ((mark === '凌晨' || mark === '早上' || mark === '早晨' || mark === '上午') && hour === 12) hour = 0;
    push(hour, minute, m[0], m.index);
  }

  // 3) 裸 24 小时制 `14:30` / `14.30`（兜底，先让带 am/pm / 时段词的写法拿走）
  const hm = /(\d{1,2})[:：.]\s*(\d{2})(?!\d)/g;
  const hasPartOfDay = /\b(?:a|p)\.?m\.?|morning|afternoon|evening|night|上午|下午|凌晨|晚上|中午/i.test(text);
  while ((m = hm.exec(text))) {
    if (spans.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    /*
     * 点号写法（ASR 常把 4:20 写成 4.20）没有任何时段词、且小时 ≤ 12 时，
     * 无法确定是上午还是下午：标 ambiguous，不擅自 +12 当下午，也不硬写成
     * 「凌晨4点20分」去和译文报冲突。> 12 的点号写法（14.30）是明确的 24
     * 小时制，不标。span 仍会占住，免得 4.20 又被当成小数金额。
     */
    const ambiguous = m[0].includes('.') && !hasPartOfDay && hour <= 12;
    if (hour <= 24 && minute <= 59) push(hour, minute, m[0], m.index, ambiguous);
  }

  return { hits, spans };
}

/** 数值：英文拼写数词 + 阿拉伯数字（含空格/逗号千分位）+ 中文数字。 */
export function scanNumbers(text: string, skip: [number, number][] = []): NumberHit[] {
  const hits: NumberHit[] = [];
  const covered = (i: number) => skip.some(([s, e]) => i >= s && i < e);

  // 1) 英文拼写数词（`twelve thousand` / `one hundred and fifty`）
  let m: RegExpExecArray | null;
  const wordRe = new RegExp(EN_WORD_NUMBER.source, 'gi');
  while ((m = wordRe.exec(text))) {
    if (covered(m.index)) continue;
    const unitText = m[1].toLowerCase().replace(/-/g, ' ').trim();
    const parts = unitText.split(/\s+/);
    let base = 0;
    if (parts.length === 2) {
      base = (EN_UNITS[parts[0]] ?? 0) + (EN_UNITS[parts[1]] ?? 0);
    } else {
      base = EN_UNITS[parts[0]] ?? 0;
    }
    const scale = EN_SCALES[m[2].toLowerCase()] ?? 1;
    const value = base * scale;
    if (value > 0) hits.push({ value, raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  /*
   * 判断一段文字是否已经被占用：调用方给的 skip（时间/日期的位置）和
   * 前面几条规则已经吃掉的 span 都算。没有这一步，「twenty five」会被
   * 拆成 20 和 5 两条，「one hundred」也会和「one hundred and fifty」
   * 各算一遍，检查时就成了「译文少了一个 100」的假警报。
   */
  const taken = (s: number, e: number) =>
    covered(s) || hits.some((h) => s < h.end && e > h.start);

  // `one hundred and fifty` 单独处理：上面那条只认到 `one hundred`
  const andRe = new RegExp(EN_HUNDRED_AND.source, 'gi');
  while ((m = andRe.exec(text))) {
    if (covered(m.index)) continue;
    const start = m.index;
    const end = start + m[0].length;
    const words = m[0].toLowerCase().split(/\s+/).filter((w) => w !== 'and');
    const value = words.reduce((acc, w) => acc * (EN_SCALES[w] ?? 0) || acc + (EN_UNITS[w] ?? 0), 0);
    if (value > 0) {
      // 整串才是真值，把之前按「数词+量级」拆出来的 100 丢掉
      for (let k = hits.length - 1; k >= 0; k -= 1) {
        if (hits[k].start >= start && hits[k].end <= end) hits.splice(k, 1);
      }
      hits.push({ value, raw: m[0], start, end });
    }
  }

  // `a hundred` / `a thousand`：数词省略成冠词，实际有数值，不能当成没提数字
  const aScaleRe = new RegExp(EN_A_SCALE.source, 'gi');
  while ((m = aScaleRe.exec(text))) {
    if (taken(m.index, m.index + m[0].length)) continue;
    const value = EN_SCALES[m[2].toLowerCase()] ?? 0;
    if (value > 0) hits.push({ value, raw: m[0], start: m.index, end: m.index + m[0].length });
  }

  // `forty-five` / `twenty five`：十位 + 个位，先整串认，别拆成两个数
  const tensRe = new RegExp(EN_BARE_TENS.source, 'gi');
  while ((m = tensRe.exec(text))) {
    if (taken(m.index, m.index + m[0].length)) continue;
    const value = (EN_UNITS[m[1].toLowerCase()] ?? 0) + (EN_UNITS[m[2].toLowerCase()] ?? 0);
    if (value > 0) hits.push({ value, raw: m[0], start: m.index, end: m.index + m[0].length });
  }

  /*
   * 单独一个数词（`platform two` / `three people`）。
   *
   * 上一版只认「数词 + hundred/thousand…」，于是 `platform two` 里的 two
   * 读不出来，译文写「2 号站台」反被判成「原文没有这个数字」—— 假警报比
   * 漏报更伤信任。这里补上，但要挡掉 `one` 当代词的情况（one of them /
   * no one / each one），那不是数量。
   */
  const bareRe = new RegExp(EN_BARE_UNIT.source, 'gi');
  while ((m = bareRe.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (taken(start, end)) continue;
    const word = m[1].toLowerCase();
    if (word === 'one' && isPronounOne(text, start)) continue;
    const value = EN_UNITS[word];
    if (value === undefined) continue;
    hits.push({ value, raw: m[0], start, end });
  }

  // 2) 阿拉伯数字 / 中文混写
  let i = 0;
  while (i < text.length) {
    if (text[i] >= '0' && text[i] <= '9' && !covered(i)) {
      /*
       * 先整段认「混写中文数字」：`1万5千` / `3万` / `2亿5000万`。
       * 必须从起点一次吃完整串 —— 早先只吃到第一个单位，`1万5千` 变成
       * `1万5` = 10005，比不识别更糟（金额被读成一个离谱的数）。
       */
      const mixed = /^[0-9][0-9零〇一二两三四五六七八九十百千万萬亿億]*/.exec(text.slice(i));
      if (mixed && /[十百千万萬亿億]/.test(mixed[0])) {
        const value = chineseNumeralToValue(mixed[0]);
        if (value != null && value > 0) {
          hits.push({ value, raw: mixed[0], start: i, end: i + mixed[0].length });
          i += mixed[0].length;
          continue;
        }
      }

      const run = readArabicRun(text, i);
      if (run && Number.isFinite(run.value)) {
        // `1.5万` / `500万`：小数或整数后面直接跟量级
        const tail = /^(万|萬|千|仟|亿|億)/.exec(text.slice(run.end));
        if (tail) {
          const mult = /万|萬/.test(tail[1]) ? 1e4 : /亿|億/.test(tail[1]) ? 1e8 : 1e3;
          hits.push({
            value: run.value * mult,
            raw: text.slice(i, run.end + tail[1].length),
            start: i,
            end: run.end + tail[1].length,
          });
          i = run.end + tail[1].length;
          continue;
        }
        hits.push({ value: run.value, raw: text.slice(i, run.end).trim(), start: i, end: run.end });
        i = run.end;
        continue;
      }
    }
    i += 1;
  }

  // 3) 纯中文数字（`一万五千` / `两万`），跳过已经算过的
  const zhRe = /[零一二两三四五六七八九十百千万亿]{2,}/g;
  while ((m = zhRe.exec(text))) {
    if (covered(m.index)) continue;
    // 与已有命中重叠则跳过
    if (hits.some((h) => m!.index >= h.start && m!.index < h.end)) continue;
    // 必须含单位，否则「三四」这种会被当成数
    if (!/[十百千万亿]/.test(m[0])) continue;
    const value = chineseNumeralToValue(m[0]);
    if (value != null && value > 0) {
      // 避免把「星期五」这类里的成分捞进来：含「星期/周/礼拜」前后缀就跳过
      const before = text.slice(Math.max(0, m.index - 3), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2);
      if (/(星期|周|礼拜)$/.test(before) || /^[点時时]/.test(after)) continue;
      hits.push({ value, raw: m[0], start: m.index, end: m.index + m[0].length });
    }
  }

  return dedupeNumbers(hits.sort((a, b) => a.start - b.start));
}

function dedupeNumbers(hits: NumberHit[]): NumberHit[] {
  const seen = new Set<string>();
  const out: NumberHit[] = [];
  for (const hit of hits) {
    const key = `${hit.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** 星期几。相对表达（明天 / 下周）不参与比对。 */
export function scanDays(text: string): DayHit[] {
  const out: DayHit[] = [];
  const lower = text.toLowerCase();
  EN_DAYS.forEach((name, index) => {
    const re = new RegExp(`\\b${name}\\b`, 'i');
    if (re.test(lower)) out.push({ day: index, raw: name });
  });
  ZH_WEEKDAY.lastIndex = 0;
  let m: RegExpExecArray | null;
  const ZH_INDEX: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
  while ((m = ZH_WEEKDAY.exec(text))) {
    const day = ZH_INDEX[m[1]];
    if (day == null) continue;
    if (!out.some((d) => d.day === day)) out.push({ day, raw: m[0] });
  }
  return out;
}

/**
 * 被否定的数值。
 *
 * 只认紧邻的否定词（`not twenty thousand` / `而不是2 000` / `不是两万`），
 * 不跨逗号 —— 「不是周二，改到周四」里的周四不能被带歪。这条边界和
 * facts.ts 里 `isNegatedValue` 保持一致，避免两处规则打架。
 */
export function negatedValues(text: string): number[] {
  const { spans } = scanTimes(text);
  const hits = scanNumbers(text, spans);
  const out: number[] = [];
  for (const hit of hits) {
    const before = text.slice(Math.max(0, hit.start - 24), hit.start);
    if (/(?:\bnot\b|\bno longer\b|\bisn't\b|\baren't\b|不是|而不是|并非|不用|不在)[^.!?。！？；;，,、]{0,18}$/i.test(before)) {
      out.push(hit.value);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* 比对                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * 方向词。
 *
 * 只收那些**明确表达方向**的说法：`move` 本身不算（它只是「改期」），
 * `postpone` / `push back` / `提前` 才算。宁可漏判，也不能把中性的改期
 * 误判成「方向被加了」—— 误报多了，用户就不看警示了。
 */
const EN_EARLIER =
  /\b(earlier|move\w*(?:\s+\w+){0,3}\s+up|bring\w*(?:\s+\w+){0,3}\s+forward|ahead of schedule|in advance)\b/i;
const EN_LATER =
  /\b(later|push\w*(?:\s+\w+){0,3}\s+back|postpone[ds]?|delay(?:ed)?|move\w*(?:\s+\w+){0,3}\s+back)\b/i;
const ZH_EARLIER = /提前|提早|提至|往前挪/;
const ZH_LATER = /推迟|延期|延后|往后挪|改晚/;

export function directionsIn(text: string, lang: 'en' | 'zh'): Direction[] {
  const out: Direction[] = [];
  if (lang === 'en') {
    if (EN_EARLIER.test(text)) out.push('earlier');
    if (EN_LATER.test(text)) out.push('later');
  } else {
    if (ZH_EARLIER.test(text)) out.push('earlier');
    if (ZH_LATER.test(text)) out.push('later');
  }
  return out;
}

const DIRECTION_LABEL: Record<Direction, string> = { earlier: '提前', later: '延后' };

function digitKey(h: NumberHit): string {
  const digits = h.raw.replace(/[^\d]/g, '');
  return digits || String(Math.round(h.value));
}

function diffNumbers(source: NumberHit[], target: NumberHit[]) {
  const srcSet = new Set(source.map((h) => h.value));
  const tgtSet = new Set(target.map((h) => h.value));
  const unsourced = target.filter((h) => !srcSet.has(h.value));
  const missing = source
    .filter((h) => !tgtSet.has(h.value))
    .filter((h) => {
      /*
       * 原文的 `seven` + `forty-five` 被译文写成 `745`：这是写法被合并，
       * 不是漏了信息。真正要提醒的是「译文里的 745 原文没有」那一条；
       * 再补两条「原文的 7 / 45 没出现」，用户只会觉得警报吵。
       */
      const key = digitKey(h);
      return !unsourced.some((u) => {
        const merged = digitKey(u);
        return merged.length > key.length && merged.includes(key);
      });
    });
  return { missing, unsourced };
}

function diffTimes(source: TimeHit[], target: TimeHit[]) {
  const key = (t: TimeHit) => `${t.hour}:${t.minute}`;
  const srcSet = new Set(source.map(key));
  const tgtSet = new Set(target.map(key));
  return {
    missing: source.filter((t) => !tgtSet.has(key(t))),
    unsourced: target.filter((t) => !srcSet.has(key(t))),
  };
}

function diffDays(source: DayHit[], target: DayHit[]) {
  const srcSet = new Set(source.map((d) => d.day));
  const tgtSet = new Set(target.map((d) => d.day));
  return {
    missing: source.filter((d) => !tgtSet.has(d.day)),
    unsourced: target.filter((d) => !srcSet.has(d.day)),
  };
}

/** 给人看的中文时间写法。`14:00` → `下午2点`，`10:30` → `上午10点30分`。 */
export function zhTime(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  let head: string;
  if (hour === 0) head = '午夜12点';
  else if (hour < 6) head = `凌晨${h12}点`;
  else if (hour < 12) head = `上午${h12}点`;
  else if (hour === 12) head = '中午12点';
  else if (hour < 18) head = `下午${h12}点`;
  else head = `晚上${h12}点`;
  return minute ? `${head}${minute}分` : head;
}

const ZH_DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function zhDay(day: number): string {
  return ZH_DAY_NAMES[day] ?? `周${day + 1}`;
}

/**
 * 主入口：比对原文与译文的关键信息。
 *
 * 只要有一项对不上就 `warn`，并给出一句能直接读的中文。
 * 不检查「译文更流畅」「多译了副词」这类问题 —— 那是翻译质量问题，
 * 这里只守「数字 / 时间 / 星期 / 否定」这四条会直接害人的线。
 */
export function checkNumericConsistency(source: string, target: string): NumericCheck {
  const empty = {
    numbers: { source: [] as NumberHit[], target: [] as NumberHit[], missing: [] as NumberHit[], unsourced: [] as NumberHit[] },
    times: { source: [] as TimeHit[], target: [] as TimeHit[], missing: [] as TimeHit[], unsourced: [] as TimeHit[] },
    days: { source: [] as DayHit[], target: [] as DayHit[], missing: [] as DayHit[], unsourced: [] as DayHit[] },
    negation: { source: [] as number[], target: [] as number[], ok: true },
    direction: { source: [] as Direction[], target: [] as Direction[], targetExtra: [] as Direction[] },
    level: 'ok' as CheckLevel,
    message: '',
  };
  if (!source.trim() || !target.trim()) return empty;

  const srcTimes = scanTimes(source);
  const tgtTimes = scanTimes(target);
  const srcNumbers = scanNumbers(source, srcTimes.spans);
  const tgtNumbers = scanNumbers(target, tgtTimes.spans);
  const srcDays = scanDays(source);
  const tgtDays = scanDays(target);

  const numDiff = diffNumbers(srcNumbers, tgtNumbers);
  const timeDiff = diffTimes(srcTimes.hits, tgtTimes.hits);
  const dayDiff = diffDays(srcDays, tgtDays);

  const srcDir = directionsIn(source, 'en');
  const tgtDir = directionsIn(target, 'zh');
  // 译文提出原文没有的方向 —— 这才是要报的；原文与译文都说了就没事。
  const dirExtra = tgtDir.filter((d) => !srcDir.includes(d));

  const srcNeg = negatedValues(source);
  const tgtNeg = negatedValues(target);
  // 否定关系一致 = 被否定数值的个数相同。值本身错了已经由数值比对抓出来。
  const negOk = srcNeg.length === tgtNeg.length;

  const parts: string[] = [];
  const ambiguousTime =
    srcTimes.hits.some((t) => t.ambiguous) || tgtTimes.hits.some((t) => t.ambiguous);
  for (const hit of numDiff.unsourced) {
    /*
     * 提示里只列「和它沾得上边」的原数：`745` 只列 seven / forty-five，
     * 不要把同一句里的平台号 2 也拉进来，那是误导。
     */
    const digits = hit.raw.replace(/\D/g, '');
    const related = srcNumbers.filter((h) => digits && digits.includes(digitKey(h)));
    const listed = related.length ? related : srcNumbers;
    const nearby = listed.length ? `（原文是 ${listed.map((h) => `${h.raw} = ${h.value}`).join(' / ')}）` : '';
    parts.push(`译文里的「${hit.raw}」在原文中找不到${nearby}`);
  }
  for (const hit of numDiff.missing) {
    parts.push(`原文的「${hit.raw}」（${hit.value}）在译文里没出现`);
  }
  for (const hit of timeDiff.unsourced) {
    if (ambiguousTime) {
      parts.push(`译文时间「${hit.raw}」对应的原文字面没写明上午还是下午，请向对方确认是几点`);
    } else {
      parts.push(`译文时间「${hit.raw}」≠ 原文 ${srcTimes.hits.map((t) => t.raw).join(' / ') || '（无时间）'}`);
    }
  }
  for (const hit of timeDiff.missing) {
    if (ambiguousTime) {
      parts.push(`原文时间「${hit.raw}」没写明上午还是下午，请向对方确认是几点`);
    } else {
      parts.push(`原文时间「${hit.raw}」（${zhTime(hit.hour, hit.minute)}）在译文里没出现`);
    }
  }
  for (const hit of dayDiff.unsourced) {
    parts.push(`译文「${hit.raw}」在原文里没有对应日期`);
  }
  for (const hit of dayDiff.missing) {
    parts.push(`原文「${hit.raw}」在译文里没出现`);
  }
  if (!negOk) {
    parts.push(`否定关系对不上：原文否定 ${srcNeg.length} 处、译文 ${tgtNeg.length} 处`);
  }
  for (const dir of dirExtra) {
    parts.push(`译文说「${DIRECTION_LABEL[dir]}」，但原文没有这个方向`);
  }
  /*
   * 只要有一侧的时间写法没写上午/下午，就必须给出澄清提示，而不是断言
   * 「凌晨4点20分 ≠ 下午4点20分」这种硬冲突。无法确定时不去补时间。
   */
  if (ambiguousTime && !parts.some((p) => p.includes('上午还是下午'))) {
    parts.push('有时间点没写明上午还是下午，请向对方确认，不要自己猜');
  }

  return {
    level: parts.length ? 'warn' : 'ok',
    numbers: { source: srcNumbers, target: tgtNumbers, ...numDiff },
    times: { source: srcTimes.hits, target: tgtTimes.hits, ...timeDiff },
    days: { source: srcDays, target: tgtDays, ...dayDiff },
    negation: { source: srcNeg, target: tgtNeg, ok: negOk },
    direction: { source: srcDir, target: tgtDir, targetExtra: dirExtra },
    message: parts.length ? `关键信息对不上，请按原文核对：${parts.join('；')}` : '',
  };
}

/* ------------------------------------------------------------------------- */
/* 中文口语化（用于确认句，避免中文句里夹英文）                                 */
/* ------------------------------------------------------------------------- */

const EN_RELATIVE: Record<string, string> = {
  today: '今天',
  tomorrow: '明天',
  tonight: '今晚',
  'this week': '这周',
  'next week': '下周',
  'next month': '下个月',
  'this month': '这个月',
};

/**
 * 把事实值翻成中文口语：`4 p.m.` → `下午4点`、`Friday` → `周五`、
 * `twelve thousand` → `一万二千`。
 *
 * 用途：中文确认句不能写「我理解的是 4 p.m.、Friday」，听障使用者读中文
 * 读到这里会卡住 —— 那正是他最需要确认的东西。
 *
 * 只处理这几类封闭集合（时间 / 星期 / 相对日期 / 金额），不碰自由文本。
 */
export function toChineseSpeech(value: string): string {
  const text = (value || '').trim();
  if (!text) return '';

  // 整串就是一个时间点
  const onlyTime = scanTimes(text);
  if (onlyTime.hits.length === 1 && onlyTime.hits[0].raw.trim() === text) {
    const t = onlyTime.hits[0];
    return zhTime(t.hour, t.minute);
  }

  // 整串就是一个星期
  const days = scanDays(text);
  if (days.length === 1 && new RegExp(`^${days[0].raw}$`, 'i').test(text)) {
    return zhDay(days[0].day);
  }

  // 相对日期
  const rel = EN_RELATIVE[text.toLowerCase()];
  if (rel) return rel;

  // 时间 + 日期混写：「Friday at 2 p.m.」
  // 按位置从后往前替换，避免 `12 000` 里的 `2 000` 被误替换后位移。
  interface Edit { start: number; end: number; text: string }
  const edits: Edit[] = [];
  for (const t of onlyTime.hits) {
    edits.push({ start: t.start, end: t.end, text: zhTime(t.hour, t.minute) });
  }
  for (const d of days) {
    const at = text.toLowerCase().indexOf(d.raw.toLowerCase());
    if (at >= 0) edits.push({ start: at, end: at + d.raw.length, text: zhDay(d.day) });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }

  // 相对日期
  for (const [en, zh] of Object.entries(EN_RELATIVE)) {
    out = out.replace(new RegExp(`\\b${en}\\b`, 'gi'), zh);
  }

  // 数值：英文拼写数词 / 阿拉伯数字 → 中文读法（确认句是要念出来的）
  const nums = scanNumbers(text);
  const numEdits: Edit[] = [];
  for (const hit of nums) {
    // 已经被上面时间替换覆盖的位置跳过
    if (edits.some((e) => hit.start >= e.start && hit.end <= e.end)) continue;
    if (hit.value >= 1000 && Number.isInteger(hit.value)) {
      numEdits.push({ start: hit.start, end: hit.end, text: numberToChineseSpeech(hit.value) });
    }
  }
  // 位置是相对原文的：只在没有任何时间/日期替换时才安全地按位置改，
  // 否则退回逐条文本替换（顺序按出现，长串先换，避免子串命中）。
  if (!edits.length) {
    numEdits.sort((a, b) => b.start - a.start);
    for (const edit of numEdits) {
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    }
  } else {
    const big = nums
      .filter((h) => h.value >= 1000 && Number.isInteger(h.value))
      .sort((a, b) => b.raw.length - a.raw.length);
    for (const hit of big) {
      out = out.replace(hit.raw, numberToChineseSpeech(hit.value));
    }
  }

  // `at` / `on` 这类介词在中文里多余
  out = out.replace(/\s+(?:at|on)\s+/gi, ' ').replace(/\s{2,}/g, ' ').trim();

  /*
   * 星期翻成中文后，前缀还是英文：`next Monday` 会变成 `next 周一`。
   * 中文确认句里留着 `next` 等于没翻，读的人还得自己拼一遍。
   */
  out = out
    .replace(/\bnext\s+(周[一二三四五六日天])/gi, '下$1')
    .replace(/\b(?:last|previous)\s+(周[一二三四五六日天])/gi, '上$1')
    .replace(/\bthis\s+(周[一二三四五六日天])/gi, '本$1')
    .replace(/\bcoming\s+(周[一二三四五六日天])/gi, '下$1');

  // 中文之间不留空格（`周五 下午2点` → `周五下午2点`），英文词之间保持原样
  out = out.replace(/\s+(?=[\u4e00-\u9fa5])/g, '').replace(/([\u4e00-\u9fa5])\s+/g, '$1');
  return out;
}

const ZH_SPEECH_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const ZH_SMALL_UNITS = ['', '十', '百', '千'];

/** 四位一组的中文读法：5000 → 五千，1200 → 一千二百。 */
function sectionToChinese(section: number): string {
  let out = '';
  let pendingZero = false;
  const digits = String(section).padStart(4, '0').split('').map(Number);
  for (let i = 0; i < 4; i += 1) {
    const digit = digits[i];
    const unit = 3 - i;
    if (digit === 0) {
      if (out) pendingZero = true;
      continue;
    }
    if (pendingZero) {
      out += '零';
      pendingZero = false;
    }
    out += ZH_SPEECH_DIGITS[digit] + ZH_SMALL_UNITS[unit];
  }
  return out;
}

/**
 * `12000` → `一万二千`、`15000` → `一万五千`、`123456` → `十二万三千四百五十六`。
 *
 * 确认句要给用户**念给对面听**，写成 `12,000` 对方听到的是一串数字，
 * 写成「一万二千」才能直接读出来。
 */
export function numberToChineseSpeech(value: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value);
  if (rounded === 0) return '零';
  if (Math.abs(rounded) >= 1e12) return String(rounded);

  const negative = rounded < 0;
  let rest = Math.abs(rounded);
  const groups: number[] = [];
  while (rest > 0) {
    groups.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  const BIG_UNITS = ['', '万', '亿', '万亿'];
  let out = '';
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    if (group === 0) {
      // 中间的整组零只补一个「零」，末尾的零不读
      if (out && !out.endsWith('零')) out += '零';
      continue;
    }
    // 高位组不满四位时，若本组小于 1000 且已有内容，要补零：「一万零五百」
    if (out && group < 1000 && !out.endsWith('零')) out += '零';
    out += sectionToChinese(group) + BIG_UNITS[i];
  }
  // 「一十五」→「十五」
  out = out.replace(/^一十/, '十');
  out = out.replace(/零+$/, '');
  return negative ? `负${out}` : out;
}
