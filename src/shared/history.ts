/**
 * 聊天记录（长期保存）的共享类型与纯函数。
 *
 * 背景：0.4.0 及以前，会话只活在渲染进程的内存数组里 —— 关掉窗口就没了，
 * 而且 `records.ts` 里还有 `slice(0, 50)`，第 51 条会把最老的一条挤掉。
 * 这一版改成主进程统一管理的 SQLite 文件：不设人为条数上限、不按时间自动
 * 删除，只有用户自己点「删除」才会真的消失。
 *
 * 这个文件里只放**不依赖 Node / Electron** 的东西，渲染层和主进程都能用，
 * 也方便直接单测（导出格式、标题推导、分页边界都做成纯函数）。
 */

import type { Speaker, TargetLanguage, ScenarioMode } from './types';
import type { SourceMode } from './sources';
import { hintSystemLabel, type HintSystem } from './languages';

/** 一条消息在库里的状态。历史里允许出现「未完成」，但不许假装成功。 */
export type HistoryMessageState = 'final' | 'partial' | 'pending' | 'failed' | 'cancelled';

export interface HistoryTranslationError {
  code: string;
  title: string;
  hint: string;
}

/** 一条已保存的消息（含字幕、译文、谐音、用户输入、已展示的 AI 回复）。 */
export interface HistoryMessage {
  id: string;
  sessionId: string;
  /** 会话内的稳定顺序号，只增不减；分页和「加载更早」都靠它。 */
  seq: number;
  /** 毫秒时间戳。 */
  ts: number;
  speaker: Speaker;
  /** 音源：系统声音 / 麦克风。现场沟通时麦克风也是「对方」。 */
  source: 'system' | 'mic' | '';
  original: string;
  translation: string;
  /** 「谐音」旧字段：中文近似音标注。等于 `hint`（提示体系是汉字时）。 */
  romanization: string;
  /**
   * 这行读音提示当时用的是哪种字系（`hanzi` / `katakana` / `romaji`）。
   *
   * 必须存下来：用户把理解语言从中文改成日语之后，旧记录的「哈喽」不能
   * 被当成片假名提示显示 —— 那是两种完全不同的标注体系。
   */
  hintSystem?: string;
  /** 生成这行提示时的算法版本。版本一变，旧提示就不该再冒充新算法的结果。 */
  hintVersion?: number;
  /** 记录这条时的「理解语言」（译文/释义用的语言）。 */
  comprehension?: string;
  /** 恢复历史时显示给用户的释义（回复面板里那一行）。 */
  meaning?: string;
  /** 音标（可选，模型给的或本地引擎算的）。 */
  ipa?: string;
  /** 音节切分（可选）。 */
  syllables?: string[];
  /** 用户自己输入的句子（中文输入 → 外语）。 */
  userInput?: string;
  /** 已经展示给用户的 AI 回复原文。 */
  reply?: string;
  state: HistoryMessageState;
  confidence?: number;
  translationError?: HistoryTranslationError;
  /** 用户改过的内容（改过就不再被模型结果覆盖）。 */
  edited?: boolean;
  correction?: string;
  /**
   * 用户**明确清空**了哪些字段。
   *
   * 数据库层的规则是「空值不覆盖已存内容」，这条规则挡住了「后到的译文更新
   * 把已存的回复冲成空」，但也顺带挡住了「用户真的想删掉这段内容」。
   * 把「没提供」和「清空」分开记，两种诉求才能同时成立。
   */
  cleared?: HistoryField[];
}

/** 可以被「明确清空」的字段（白名单）。 */
export const HISTORY_CLEARABLE_FIELDS = [
  'translation',
  'romanization',
  'reply',
  'correction',
  'meaning',
  'userInput',
] as const;

export type HistoryField = (typeof HISTORY_CLEARABLE_FIELDS)[number];

/** 等待落库的一条 AI 回复。 */
export interface PendingReply {
  id: string;
  text: string;
}

/**
 * 把待写回复并进这一批，并告诉调用方「这次到底带上了没有」。
 *
 * 这段逻辑以前直接写在渲染进程的 `runFlush()` 里，而且顺序错了：先把回复
 * 塞进「已保存」缓存、再把待写变量清空，最后才发数据库。于是数据库一旦失败，
 * 回复既不在重试队列里、也不在待写变量里 —— 永久丢失，界面还写着「尚未保存」。
 *
 * 抽成纯函数之后有两件事变得可测：
 *  1. 带上了（`replySent === true`）才允许清 `pendingReply`；
 *  2. 没带上（这一行还没进库）时**不伪造成功**，下次再补。
 *
 * 不修改传入的数组，返回新数组 —— 调用方手里那份快照还要用来比对。
 */
export function attachPendingReply(
  rows: HistoryMessage[],
  known: Map<string, HistoryMessage>,
  reply: PendingReply | null,
): { rows: HistoryMessage[]; replySent: boolean } {
  if (!reply) return { rows, replySent: false };

  const next = rows.slice();
  const index = next.findIndex((row) => row.id === reply.id);
  if (index >= 0) {
    // 这一行本身就在这批里：只加 reply 字段，其它字段用最新的快照。
    next[index] = { ...next[index], reply: reply.text };
    return { rows: next, replySent: true };
  }
  const base = known.get(reply.id);
  if (base) {
    next.push({ ...base, reply: reply.text });
    return { rows: next, replySent: true };
  }
  // 这一行还没进库：留着回复，等这一行出现再补，不假装写完。
  return { rows: next, replySent: false };
}

/** 事实卡上的一次动作（改值 / 确认 / 取消确认）。 */
export interface HistoryFactLog {
  at: number;
  action: 'edited' | 'confirmed' | 'unconfirmed';
  from?: string;
  to?: string;
}

export interface HistoryFact {
  id: string;
  sessionId: string;
  /** 来源字幕 id（点一下能跳回那句话）。 */
  messageId: string;
  kind: string;
  value: string;
  sourceText: string;
  certainty: string;
  confirmed?: boolean;
  edited?: boolean;
  createdAt: number;
  /** 片段取自原话还是译文。 */
  sourceField?: string;
  /** 这个值在原话里被明确否定了（旧值，不能当当前信息用）。 */
  negated?: boolean;
  /** 用户改之前的值。 */
  originalValue?: string;
  status?: 'pending' | 'confirmed';
  /** 用户手动点确认的时刻；自动提取不算。 */
  confirmedAt?: number;
  /** 修改 / 确认时间线。 */
  log?: HistoryFactLog[];
  /** 改完值之后「现在该怎么说」（目标语言）。 */
  spoken?: string;
  /** 这句话是用户自己写的，还是规则推出来的。 */
  spokenSource?: 'user' | 'derived';
  /** 记这条时的理解语言 / 目标语言 / 提示体系。 */
  comprehension?: string;
  targetLanguage?: string;
  hintSystem?: string;
}

export interface HistorySession {
  id: string;
  title: string;
  /** 想说的语言（这笔对话里对方听的是哪一种）。 */
  language: TargetLanguage;
  /** 理解语言：字幕译文翻成哪一种。旧记录为空，表示当时的 0.5.0 写死中文。 */
  comprehension?: string;
  /** 这段对话里用的读音提示体系。跨会话不再混用。 */
  hintSystem?: string;
  scenario: ScenarioMode;
  sourceMode: SourceMode;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** 列表页只拿摘要，不把几千条消息一起塞进内存。 */
export type HistorySessionSummary = HistorySession;

export interface HistoryPage {
  sessionId: string;
  /** 从新到旧返回；调用方按 seq 升序渲染。 */
  messages: HistoryMessage[];
  /** 还有更早的消息可以继续加载。 */
  hasMore: boolean;
  /** 本页最早一条的 seq（下次向上加载的游标）。 */
  nextBeforeSeq: number | null;
}

export interface HistoryStatus {
  /** 数据库是否已经打开可用。 */
  ready: boolean;
  /** 数据库文件的绝对路径（界面可以显示，方便用户备份）。 */
  file: string;
  /** 文件大小（字节）。 */
  bytes: number;
  sessions: number;
  messages: number;
  /** 最近一次写入失败的说明（成功时为空）。 */
  lastError: string;
  /** 完整性自检结果：ok / 具体问题。 */
  integrity: string;
}

export interface HistoryError {
  code:
    | 'not-ready'
    | 'open-failed'
    | 'write-failed'
    | 'read-failed'
    | 'disk-full'
    | 'locked'
    | 'migration-failed'
    | 'unknown';
  title: string;
  hint: string;
}

export const HISTORY_PAGE_SIZE = 50;

/**
 * 每种错误码对应的说法与下一步。
 *
 * 写成表而不是一串 if：主进程和渲染层都会调用它，必须给出**同一个**说法；
 * 而且已经描述过的错误（带 code 的对象）再描述一次要字段一致 ——
 * 否则「磁盘满」在主进程是「磁盘满」、到了界面变成「记录操作失败」。
 */
const HISTORY_ERROR_TEXT: Record<HistoryError['code'], { title: string; hint: string }> = {
  'not-ready': {
    title: '记录还没准备好',
    hint: '稍等一下再试；如果一直这样，先看「一键诊断」里的记录项，或者点「打开记录文件夹」确认目录在。',
  },
  'open-failed': {
    title: '记录文件打不开',
    hint: '点「打开记录文件夹」确认目录存在且可写，再重试。已经写进去的旧记录不会因为这个失败被删除。',
  },
  'write-failed': {
    title: '这一条没能写入记录文件',
    hint: '点「重试保存」。界面会一直显示「尚未保存」，不会假装已经保存成功。',
  },
  'read-failed': {
    title: '记录读不出来',
    hint: '先导出还能读到的部分做备份，别删文件；然后重开软件再试。',
  },
  'disk-full': {
    title: '磁盘空间不足，记录没能保存',
    hint: '先清理磁盘（或把记录导出后删掉一些旧会话），再点「重试保存」。已经保存过的内容不会丢。',
  },
  locked: {
    title: '记录文件被占用',
    hint: '如果同时开了两个本软件，先关掉另一个；然后点「重试保存」。',
  },
  'migration-failed': {
    title: '记录升级没完成',
    hint: '先点「打开记录文件夹」把 history.db 复制一份备份，再重开软件；不要直接删库。',
  },
  unknown: {
    title: '记录操作失败',
    hint: '点「重试保存」再试一次；如果一直失败，先导出备份，再查看应用日志里的错误码。',
  },
};

export const HISTORY_ERROR_CODES = Object.keys(HISTORY_ERROR_TEXT) as HistoryError['code'][];

/** 把数据库异常翻成「用户能照着做」的说明。不含 SQL、不含文件内容。 */
export function describeHistoryError(error: unknown): HistoryError {
  const make = (code: HistoryError['code']): HistoryError => ({
    code,
    ...HISTORY_ERROR_TEXT[code],
  });

  // 1) 已经描述过的（带已知 code）→ 原样沿用它的 code，文案取表里的标准说法。
  //    这样主进程 → 渲染层转手一次也不会丢信息。
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && (HISTORY_ERROR_CODES as string[]).includes(code)) {
      return make(code as HistoryError['code']);
    }
  }

  // 2) 原始异常：只按关键字归类，绝不把 SQL / 文件内容转给用户。
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const upper = raw.toUpperCase();

  if (upper.includes('SQLITE_FULL') || upper.includes('DISK') || upper.includes('NO SPACE')) {
    return make('disk-full');
  }
  if (upper.includes('SQLITE_BUSY') || upper.includes('LOCKED')) {
    return make('locked');
  }
  if (upper.includes('READONLY') || upper.includes('PERMISSION') || upper.includes('EACCES')) {
    return make('write-failed');
  }
  if (upper.includes('CORRUPT') || upper.includes('MALFORMED')) {
    return make('read-failed');
  }
  if (upper.includes('USER_VERSION') || upper.includes('MIGRAT')) {
    return make('migration-failed');
  }
  return make('unknown');
}

/** 记录标题：第一句有内容的对方原文（退化成第一句，再退化成时间）。 */
export function deriveSessionTitle(texts: string[], at: number): string {
  const first = texts.map((text) => text.replace(/\s+/g, ' ').trim()).find(Boolean);
  if (!first) {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `空白记录 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}

/** 旧的「谐音」在导出文件里的标签（按当时的字系给名字，不一律写「谐音」）。 */
function hintLabelOf(system: string | undefined): string {
  if (!system) return '谐音';
  const known: HintSystem[] = ['hanzi', 'katakana', 'romaji', 'none'];
  if (!(known as string[]).includes(system)) return '谐音';
  return hintSystemLabel(system as HintSystem);
}

/** 把一条消息摊平成可读文本（导出用）。 */
export function messageToText(message: HistoryMessage): string {  const lines: string[] = [];
  const time = new Date(message.ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  const who = message.speaker === 'foreign' ? '对方' : '你';
  const stateNote =
    message.state === 'failed'
      ? '（翻译失败）'
      : message.state === 'cancelled'
        ? '（已停止翻译）'
        : message.state === 'pending'
          ? '（翻译中）'
          : message.state === 'partial'
            ? '（未完成识别）'
            : '';

  lines.push(`### ${stamp} ${who}${stateNote}`);
  if (message.original) lines.push(`原文：${message.original}`);
  if (message.translation) lines.push(`译文：${message.translation}`);
  if (message.romanization) {
    // 标签跟着当时的字系走：这条记录可能是「哈喽」，也可能是「ハロー」。
    // 一律写成「谐音」会让换过理解语言的用户看不懂自己导出的文件。
    const label = hintLabelOf(message.hintSystem);
    lines.push(`${label}：${message.romanization}`);
  }
  if (message.meaning) lines.push(`释义：${message.meaning}`);
  if (message.ipa) lines.push(`音标：${message.ipa}`);
  if (message.syllables?.length) lines.push(`音节：${message.syllables.join(' · ')}`);
  if (message.userInput) lines.push(`我输入：${message.userInput}`);
  if (message.reply) lines.push(`AI 回复：${message.reply}`);
  if (message.correction) lines.push(`更自然：${message.correction}`);
  if (message.translationError) {
    lines.push(`失败原因：${message.translationError.title} · ${message.translationError.hint}`);
  }
  return lines.join('\n');
}

/** 把一个会话导出成可读文本。`messages` 必须按 seq 升序。 */
export function sessionToText(
  session: HistorySession,
  messages: HistoryMessage[],
  facts: HistoryFact[] = [],
): string {
  const created = new Date(session.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const head = [
    `# ${session.title || '（无标题）'}`,
    '',
    `- 开始时间：${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())} ${pad(created.getHours())}:${pad(created.getMinutes())}`,
    `- 对话语言：${session.language}`,
    ...(session.comprehension ? [`- 理解语言：${session.comprehension}`] : []),
    ...(session.hintSystem
      ? [`- 读音提示：${hintLabelOf(session.hintSystem)}（近似标注，不等同准确发音）`]
      : []),
    `- 场景：${session.scenario}`,
    `- 音源用途：${session.sourceMode === 'onsite' ? '现场沟通（麦克风）' : '线上交流（电脑声音）'}`,
    `- 消息条数：${messages.length}`,
    '',
    '> 读音提示只是近似标注（汉字近音 / 片假名 / 罗马字），只能帮助回忆读音，不等同于准确发音。',
    '',
  ];

  const body = messages.map(messageToText).join('\n\n');

  const factBlock = facts.length
    ? ['', '## 关键信息', ...facts.map((f) => `- ${f.kind}：${f.value}${f.sourceText ? `（出自「${f.sourceText}」）` : ''}`)].join('\n')
    : '';

  return `${head.join('\n')}${body}${factBlock}\n`;
}

/** 搜索命中片段：把命中的那一段截出来（导出/列表都能用）。 */
export function snippetOf(message: HistoryMessage, query: string, span = 40): string {
  const haystack = `${message.original}\n${message.translation}\n${message.romanization}`;
  const index = haystack.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return message.translation || message.original;
  const start = Math.max(0, index - 12);
  const end = Math.min(haystack.length, index + query.length + span);
  return `${start > 0 ? '…' : ''}${haystack.slice(start, end).replace(/\s+/g, ' ')}${end < haystack.length ? '…' : ''}`;
}

/** 空状态（没打开 / 打不开时界面用它，避免 undefined 到处跑）。 */
export function emptyHistoryStatus(): HistoryStatus {
  return {
    ready: false,
    file: '',
    bytes: 0,
    sessions: 0,
    messages: 0,
    lastError: '',
    integrity: '',
  };
}

/**
 * 所有记录相关 IPC 的统一回执。
 *
 * 失败时必须带上分类 + 标题 + 下一步，绝不允许「回一个空字符串让界面自己猜」。
 */
export type HistoryResult<T> = { ok: true; data: T } | { ok: false; error: HistoryError };

export interface HistoryExportResult {
  canceled: boolean;
  path: string;
  sessions: number;
  messages: number;
  bytes: number;
}

export interface HistoryBackupResult {
  canceled: boolean;
  path: string;
  bytes: number;
}
