import { create } from 'zustand';
import type { ConversationItem } from '../../shared/types';
import type { TranscriptPayload } from '../../shared/ipc';
import type { TranslationState } from '../../shared/subtitle-state';
import { cancelPendingTranslation } from '../../shared/subtitle-state';
import { useSettingsStore } from './settings';

/**
 * 这一句的采集通道，在字幕产生这一刻读一次。
 *
 * 不放到写库时算：用户完全可能听完一句就把模式从「线上会议」切到
 * 「现场沟通」，那时候再按当前设置反推，会把前一句的来路写错。
 */
function currentSourceStamp(): { audioSource: 'system' | 'mic'; comprehension?: string } {
  try {
    const current = useSettingsStore.getState().settings;
    return {
      audioSource: current.audio.sourceMode === 'onsite' ? 'mic' : 'system',
      comprehension: current.nativeLanguage,
    };
  } catch {
    return { audioSource: 'system' };
  }
}

interface ConversationState {
  items: ConversationItem[];
  /** id of the item currently being streamed (partial). */
  partialId: string | null;
  /**
   * 现在是第几「轮」。
   *
   * 一轮 = 对方说完一句外语。看视频 / 做听力时用户真正关心的是「刚刚那轮我
   * 该怎么接」，所以轮次要显式暴露出来：界面上显示「第 N 轮」，回复面板也知道
   * 自己手上的三张卡是哪一轮的 —— 否则新一轮开始后旧卡片还挂在那里，看起来
   * 就像「第二轮没被监听」（用户原话：「无法开启第二轮对话监听」）。
   */
  roundIndex: number;
  /** 最近一轮外语原文，用于「新一轮」提示与快捷操作。 */
  lastForeignText: string;
  /** Ingests a transcript event. Returns the finalized item, if any. */
  upsert: (payload: TranscriptPayload) => ConversationItem | null;
  setTranslation: (id: string, translatedText: string) => void;
  /**
   * 只改译文状态、不动译文。翻译失败 / 被取消时用它，界面才有东西可提示。
   */
  setTranslationState: (id: string, state: TranslationState) => void;
  /** 停止监听时把还在翻的字幕标成「已取消」（不是失败，用词要区分）。 */
  cancelPendingTranslations: () => void;
  /**
   * 记下「这一句翻失败了，原因是 X」。
   *
   * 只写一个 `failed` 是不够的：断网、Key 过期、余额不足、模型不认
   * 这四件事的下一步动作完全不同，用户得知道该去改哪一处。
   */
  setTranslationError: (id: string, error: { code: string; title: string; hint: string }) => void;
  /**
   * 「这里有一段没转写」的标记。
   *
   * 队列积压、识别超时、识别失败都会丢掉真实的语音。只在日志里写一行，
   * 用户就会以为字幕是完整的 —— 然后拿漏掉的信息去做决定。标记要和字幕
   * 按时间混排，才能表示「它发生在这一句和下一句之间」。
   */
  marks: DropMark[];
  addMark: (mark: { at: number; reason: string }) => void;
  setCorrection: (id: string, correction: string, note: string) => void;
  /**
   * 记下这一句的中文近似音（谐音）。
   *
   * 由本地引擎算，不花任何模型额度；写进字幕项是为了让历史记录能原样还原
   * 「当时看到的那行字」—— 打开旧记录时不允许再算一遍。
   */
  /**
   * 存下这行读音提示，同时记下**当时用的提示体系**。
   *
   * 只存文字是不够的：用户换了理解语言之后，历史里那行汉字近音会被
   * 当成新体系的读数去理解。存住 system 才能说清「这是当时的汉字近音」。
   */
  setRomanization: (id: string, romanization: string, hintSystem?: string, hintVersion?: number) => void;
  clear: () => void;
  /** Replace the live transcript (used when opening a saved record). */
  loadItems: (items: ConversationItem[]) => void;
  /** 在顶部插入更早的一页（历史记录向上翻）。顺序靠 seq，不重排已有内容。 */
  prependItems: (items: ConversationItem[]) => void;
  /**
   * 「更早的内容还没加载完」。
   *
   * 只在看历史记录时为 true —— 顶部会出现「加载更早」，避免用户以为
   * 「这段记录一共就这么几句」。实时采集永远为 false。
   */
  hasEarlier: boolean;
  setHasEarlier: (value: boolean) => void;
  /**
   * 屏幕上最多保留多少条（**只影响显示与内存**）。
   *
   * 这不是历史记录的条数上限：数据库里一条都不删，这里只是「同时渲染多少」。
   * 旧实现把它当成了保存上限（`slice(0, 50)`），于是老记录真的消失了。
   */
  historyLimit: number;
  setHistoryLimit: (limit: number) => void;
  /** Recent conversation formatted for the LLM prompt. */
  contextText: (limit?: number) => string;
  recentItems: (limit?: number) => ConversationItem[];
  /** The utterance currently being streamed, if any (used for live translation). */
  partialItem: () => ConversationItem | null;
  /** Most recent finalized foreign utterance (used by the live subtitle bar). */
  lastForeign: () => ConversationItem | null;
}

export interface DropMark {
  id: string;
  /** 大致发生时间，用来和字幕混排。 */
  at: number;
  reason: string;
}

/** Hard ceiling: enough to scroll through a long call, small enough for memory. */
const MAX_ITEMS = 2000;
/** 标记最多留这么多，避免长时间运行时无限增长。 */
const MAX_MARKS = 50;
const CONTEXT_WINDOW_MS = 60_000;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  items: [],
  partialId: null,
  roundIndex: 0,
  lastForeignText: '',
  historyLimit: 400,
  marks: [],
  hasEarlier: false,
  setHasEarlier: (hasEarlier) => set({ hasEarlier }),

  prependItems: (incoming) =>
    set((state) => {
      if (!incoming.length) return {};
      const seen = new Set(state.items.map((item) => item.id));
      const fresh = incoming.filter((item) => !seen.has(item.id));
      if (!fresh.length) return {};
      // 不去重排序之外做任何加工：更早的一页就是更早的一页。
      return { items: [...fresh, ...state.items] };
    }),

  upsert: (payload) => {
    const { items, partialId } = get();
    const limit = Math.min(get().historyLimit, MAX_ITEMS);
    const trimmed = payload.text.trim();
    if (!trimmed) return null;

    if (payload.partial) {
      // Keep streaming into the same bubble while it is still partial.
      const existing =
        partialId !== null ? items.find((item) => item.id === partialId) : undefined;
      if (existing && existing.speaker === payload.speaker) {
        const updated = items.map((item) =>
          item.id === existing.id ? { ...item, originalText: trimmed } : item,
        );
        set({ items: updated });
        return null;
      }
      const created: ConversationItem = {
        id: nextId(),
        timestamp: Date.now(),
        speaker: payload.speaker,
        originalText: trimmed,
        confidence: payload.confidence,
        partial: true,
        ...currentSourceStamp(),
      };
      set({ items: [...items, created].slice(-limit), partialId: created.id });
      return null;
    }

    // Final result: reuse the partial bubble so the subtitle does not jump.
    const existing =
      partialId !== null ? items.find((item) => item.id === partialId) : undefined;
    // 一句外语定稿 = 新一轮开始。轮次是「多轮对话监听」在界面上的锚点：
    // 没有它，用户根本分不清「第二轮没被监听」和「第二轮正在听」。
    const foreignRound =
      payload.speaker === 'foreign'
        ? { roundIndex: get().roundIndex + 1, lastForeignText: trimmed }
        : {};
    let finalized: ConversationItem;
    if (existing && existing.speaker === payload.speaker) {
      finalized = {
        ...existing,
        originalText: trimmed,
        confidence: payload.confidence ?? existing.confidence,
        partial: false,
      };
      set({
        items: items
          .map((item) => (item.id === existing.id ? finalized : item))
          .slice(-limit),
        partialId: null,
        ...foreignRound,
      });
    } else {
      finalized = {
        id: nextId(),
        timestamp: Date.now(),
        speaker: payload.speaker,
        originalText: trimmed,
        confidence: payload.confidence,
        partial: false,
        ...currentSourceStamp(),
      };
      set({ items: [...items, finalized].slice(-limit), partialId: null, ...foreignRound });
    }
    return finalized;
  },

  setTranslation: (id, translatedText) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, translatedText, translationState: 'ok' as const } : item,
      ),
    })),

  setTranslationState: (id, translationState) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, translationState } : item)),
    })),

  setTranslationError: (id, translationError) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id
          ? { ...item, translationState: 'failed' as const, translationError }
          : item,
      ),
    })),

  addMark: ({ at, reason }) =>
    set((state) => ({
      marks: [...state.marks, { id: nextId(), at, reason }].slice(-MAX_MARKS),
    })),

  cancelPendingTranslations: () =>
    set((state) => {
      let changed = false;
      const items = state.items.map((item) => {
        const next = cancelPendingTranslation(item.translationState);
        if (next === item.translationState) return item;
        changed = true;
        return { ...item, translationState: next as TranslationState };
      });
      return changed ? { items } : {};
    }),

  setCorrection: (id, correction, note) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, correction, correctionNote: note } : item,
      ),
    })),

  setRomanization: (id, romanization, hintSystem, hintVersion) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id &&
        (item.romanization !== romanization ||
          item.hintSystem !== hintSystem ||
          item.hintVersion !== hintVersion)
          ? { ...item, romanization, hintSystem, hintVersion }
          : item,
      ),
    })),

  /*
   * 清空**当前显示**。
   *
   * 注意这不等于删除记录：库里那一段完整保留，用户随时能在「记录」里找回来。
   * 三个动作必须分开 —— 停止采集 / 清空显示 / 删除历史。
   */
  clear: () =>
    set({
      items: [],
      marks: [],
      partialId: null,
      roundIndex: 0,
      lastForeignText: '',
      hasEarlier: false,
    }),

  loadItems: (items) =>
    set({
      items: items.slice(-MAX_ITEMS),
      marks: [],
      partialId: null,
      roundIndex: items.filter((item) => item.speaker === 'foreign' && !item.partial).length,
      lastForeignText:
        [...items].reverse().find((item) => item.speaker === 'foreign' && !item.partial)
          ?.originalText ?? '',
    }),

  setHistoryLimit: (limit) =>
    set({ historyLimit: Math.min(MAX_ITEMS, Math.max(20, Math.floor(limit))) }),

  recentItems: (limit = 12) => {
    const items = get().items.filter((item) => !item.partial);
    const cutoff = Date.now() - CONTEXT_WINDOW_MS;
    const windowed = items.filter((item) => item.timestamp >= cutoff);
    return (windowed.length ? windowed : items).slice(-limit);
  },

  partialItem: () => {
    const { items, partialId } = get();
    if (partialId === null) return null;
    return items.find((item) => item.id === partialId) ?? null;
  },

  lastForeign: () => {
    const items = get().items;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].speaker === 'foreign') return items[index];
    }
    return null;
  },

  contextText: (limit = 12) =>
    get()
      .recentItems(limit)
      .map((item) => {
        const label = item.speaker === 'foreign' ? 'Foreign' : 'You';
        return `${label}: ${item.originalText}`;
      })
      .join('\n'),
}));
