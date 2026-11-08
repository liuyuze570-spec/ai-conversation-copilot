import type { HintSystem } from './languages';

/**
 * 个人词表：用户自己修正过的读音。
 *
 * ## 为什么要有
 *
 * 规则引擎对「人名、公司名、专业词」几乎无能为力：`Nguyen`、`Kubernetes`、
 * 同事的名字，词典里没有就只能标「未确定」。而这类词恰恰是使用者每天都要
 * 念的 —— 让用户自己填一次，比让引擎猜一辈子有用。
 *
 * ## 两条硬规矩
 *
 * 1. **用户填的不能冒充「专家核对」**。所以这条记录带 `origin: 'manual'`，
 *    界面显示「你填的」，不显示「已核对」。
 * 2. **按提示体系分开存**。同一个词，汉字近音和罗马字是两套写法；用户填了
 *    汉字近音，不代表他同意片假名也这么写。
 */
export interface CustomReading {
  /** 原文里的词（英文/日文原样，匹配时忽略大小写与首尾空格）。 */
  word: string;
  /** 用户给的读音提示（汉字近音 / 片假名 / 罗马字，跟着 system 走）。 */
  reading: string;
  /** 这套读音属于哪种提示体系。 */
  system: HintSystem;
  updatedAt: number;
}

/** 词条长度上限：超过这个长度的「词」基本是整句，不适合当词表。 */
export const CUSTOM_WORD_MAX = 40;

/**
 * 清洗用户输入。
 *
 * 空词、空读音、长度离谱、同一体系下重复的词都丢掉（后者保留最新一条）。
 * 返回的数组**不含**非本体系以外的条目 —— 调用方按体系过滤。
 */
export function sanitizeCustomReadings(input: unknown): CustomReading[] {
  if (!Array.isArray(input)) return [];
  const byKey = new Map<string, CustomReading>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<CustomReading>;
    const word = typeof item.word === 'string' ? item.word.trim() : '';
    const reading = typeof item.reading === 'string' ? item.reading.trim() : '';
    const system = item.system;
    if (!word || !reading) continue;
    if (word.length > CUSTOM_WORD_MAX || reading.length > CUSTOM_WORD_MAX) continue;
    if (system !== 'hanzi' && system !== 'katakana' && system !== 'romaji') continue;
    const key = `${system}|${word.toLowerCase()}`;
    const prev = byKey.get(key);
    const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : 0;
    if (!prev || prev.updatedAt <= updatedAt) {
      byKey.set(key, { word, reading, system, updatedAt });
    }
  }
  return [...byKey.values()];
}

/** 按词精确查找（忽略大小写与首尾空格）。 */
export function findCustomReading(
  word: string,
  system: HintSystem,
  list: CustomReading[] | undefined,
): CustomReading | undefined {
  if (!list?.length) return undefined;
  const needle = word.trim().toLowerCase();
  if (!needle) return undefined;
  return list.find((item) => item.system === system && item.word.trim().toLowerCase() === needle);
}

/**
 * 加一条（同一体系下同词覆盖），返回新数组。
 *
 * 不就地修改：设置存的是快照，改一半被读取会读到不一致的中间态。
 */
export function upsertCustomReading(
  list: CustomReading[] | undefined,
  entry: { word: string; reading: string; system: HintSystem; updatedAt?: number },
): CustomReading[] {
  const next = sanitizeCustomReadings(list ?? []).filter(
    (item) =>
      !(item.system === entry.system && item.word.trim().toLowerCase() === entry.word.trim().toLowerCase()),
  );
  const cleaned = sanitizeCustomReadings([{ ...entry, updatedAt: entry.updatedAt ?? Date.now() }]);
  return [...next, ...cleaned];
}

export function removeCustomReading(
  list: CustomReading[] | undefined,
  entry: { word: string; system: HintSystem },
): CustomReading[] {
  return sanitizeCustomReadings(list ?? []).filter(
    (item) =>
      !(item.system === entry.system && item.word.trim().toLowerCase() === entry.word.trim().toLowerCase()),
  );
}
