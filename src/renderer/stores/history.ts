import { create } from 'zustand';
import {
  emptyHistoryStatus,
  HISTORY_PAGE_SIZE,
  type HistoryError,
  type HistoryPage,
  type HistoryResult,
  type HistorySession,
  type HistoryStatus,
} from '../../shared/history';

/**
 * 聊天记录的界面状态。
 *
 * 分工：
 *  - 主进程负责**真相**（SQLite 文件、事务、分页、搜索、导出）；
 *  - 这里只负责「当前这一屏要显示什么」+「上次保存成没成」。
 *
 * 关键的设计取舍：界面**只加载一页**。一百个会话、一万条消息的用户，
 * 打开「记录」时不能把全部内容一次性读进内存 —— 那正是旧实现
 * （一个内存数组 + slice(0,50)）的两个毛病：既装不下，又会删数据。
 */

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

interface HistoryState {
  status: HistoryStatus;
  /** 会话列表（分页累加）。 */
  sessions: HistorySession[];
  total: number;
  listLoading: boolean;
  loadedAll: boolean;
  /** 搜索结果（null = 没在搜索）。 */
  results: (HistorySession & { snippet: string; hits: number })[] | null;
  query: string;
  searching: boolean;

  /** 正在查看的那段记录（null = 不在记录面板里）。 */
  detailId: string | null;
  detail: HistoryPage | null;
  detailLoading: boolean;

  /** 保存状态：只有拿到主进程回执才允许显示「已保存」。 */
  saveState: SaveState;
  saveError: HistoryError | null;
  savedAt: number;
  pendingCount: number;
  /**
   * 事实卡单独的保存状态。
   *
   * 字幕存成功不等于事实卡存成功 —— 两套数据、两次写入。混用一个状态，
   * 事实卡写失败时界面还写着「已保存」，用户以为改过的金额已经落盘了。
   */
  factSaveState: SaveState;
  factSaveError: HistoryError | null;
  setFactSave: (state: SaveState, error?: HistoryError | null) => void;

  refreshStatus: () => Promise<void>;
  loadSessions: (reset?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
  openDetail: (id: string) => Promise<void>;
  loadEarlier: () => Promise<void>;
  closeDetail: () => void;
  remove: (id: string) => Promise<{ ok: boolean; message?: string }>;
  clearAll: () => Promise<{ ok: boolean; message?: string }>;
  exportData: (payload?: {
    sessionId?: string;
    format?: 'text' | 'json';
  }) => Promise<{ ok: boolean; message: string }>;
  backup: () => Promise<{ ok: boolean; message: string }>;
  openFolder: () => Promise<void>;

  /** 由同步层调用。 */
  setSaveState: (state: SaveState, options?: { error?: HistoryError | null; at?: number }) => void;
  setPendingCount: (count: number) => void;
}

function unwrap<T>(result: HistoryResult<T>): { ok: true; data: T } | { ok: false; error: HistoryError } {
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  status: emptyHistoryStatus(),
  sessions: [],
  total: 0,
  listLoading: false,
  loadedAll: false,
  results: null,
  query: '',
  searching: false,
  detailId: null,
  detail: null,
  detailLoading: false,
  saveState: 'idle',
  saveError: null,
  savedAt: 0,
  pendingCount: 0,
  factSaveState: 'idle',
  factSaveError: null,

  refreshStatus: async () => {
    try {
      const result = await window.copilot.historyStatus();
      const parsed = unwrap(result);
      if (parsed.ok) set({ status: parsed.data });
      else set({ status: { ...emptyHistoryStatus(), lastError: parsed.error.title } });
    } catch {
      set({ status: { ...emptyHistoryStatus(), lastError: '读不到记录状态' } });
    }
  },

  loadSessions: async (reset = true) => {
    if (get().listLoading) return;
    set({ listLoading: true });
    try {
      const offset = reset ? 0 : get().sessions.length;
      const result = unwrap(await window.copilot.historyList({ limit: 30, offset }));
      if (!result.ok) {
        set({ listLoading: false });
        return;
      }
      const items = result.data.items;
      set({
        sessions: reset ? items : [...get().sessions, ...items],
        total: result.data.total,
        loadedAll: (reset ? items.length : get().sessions.length + items.length) >= result.data.total,
        listLoading: false,
      });
    } catch {
      set({ listLoading: false });
    }
  },

  loadMore: async () => {
    if (get().listLoading || get().loadedAll) return;
    await get().loadSessions(false);
  },

  search: async (query) => {
    const text = query.trim();
    if (!text) {
      set({ results: null, query: '', searching: false });
      return;
    }
    set({ searching: true, query: text });
    try {
      const result = unwrap(await window.copilot.historySearch({ query: text, limit: 50 }));
      set({
        results: result.ok ? result.data.items : [],
        searching: false,
      });
    } catch {
      set({ results: [], searching: false });
    }
  },

  clearSearch: () => set({ results: null, query: '', searching: false }),

  openDetail: async (id) => {
    set({ detailId: id, detail: null, detailLoading: true });
    try {
      const result = unwrap(
        await window.copilot.historyPage({ sessionId: id, limit: HISTORY_PAGE_SIZE }),
      );
      set({
        detail: result.ok ? result.data : null,
        detailLoading: false,
      });
    } catch {
      set({ detail: null, detailLoading: false });
    }
  },

  loadEarlier: async () => {
    const { detailId, detail, detailLoading } = get();
    if (!detailId || !detail?.hasMore || detailLoading || detail.nextBeforeSeq == null) return;
    set({ detailLoading: true });
    try {
      const result = unwrap(
        await window.copilot.historyPage({
          sessionId: detailId,
          beforeSeq: detail.nextBeforeSeq,
          limit: HISTORY_PAGE_SIZE,
        }),
      );
      if (result.ok) {
        // 拼在前面：更早的内容在上，顺序稳定，不重复（游标是 seq < beforeSeq）。
        set({
          detail: {
            ...result.data,
            messages: [...result.data.messages, ...detail.messages],
          },
          detailLoading: false,
        });
      } else {
        set({ detailLoading: false });
      }
    } catch {
      set({ detailLoading: false });
    }
  },

  closeDetail: () => set({ detailId: null, detail: null }),

  remove: async (id) => {
    try {
      const result = unwrap(await window.copilot.historyDelete({ id }));
      if (!result.ok) return { ok: false, message: result.error.hint };
      if (get().detailId === id) set({ detailId: null, detail: null });
      await get().loadSessions(true);
      await get().refreshStatus();
      return { ok: true };
    } catch {
      return { ok: false, message: '删除失败，请重试' };
    }
  },

  clearAll: async () => {
    try {
      const result = unwrap(await window.copilot.historyClear());
      if (!result.ok) return { ok: false, message: result.error.hint };
      set({ sessions: [], total: 0, results: null, detailId: null, detail: null });
      await get().refreshStatus();
      return { ok: true };
    } catch {
      return { ok: false, message: '清空失败，请重试' };
    }
  },

  exportData: async (payload = {}) => {
    try {
      const result = unwrap(await window.copilot.historyExport(payload));
      if (!result.ok) return { ok: false, message: `${result.error.title} · ${result.error.hint}` };
      if (result.data.canceled) return { ok: false, message: '已取消导出' };
      const mb = (result.data.bytes / 1024 / 1024).toFixed(2);
      return {
        ok: true,
        message: `已导出 ${result.data.sessions} 段会话、${result.data.messages} 条消息（${mb} MB）到：${result.data.path}`,
      };
    } catch {
      return { ok: false, message: '导出失败，请重试' };
    }
  },

  backup: async () => {
    try {
      const result = unwrap(await window.copilot.historyBackup());
      if (!result.ok) return { ok: false, message: `${result.error.title} · ${result.error.hint}` };
      if (result.data.canceled) return { ok: false, message: '已取消备份' };
      return {
        ok: true,
        message: `备份完成（${(result.data.bytes / 1024).toFixed(0)} KB）：${result.data.path}。恢复时先退出软件，再用它替换用户数据目录里的 history.db。`,
      };
    } catch {
      return { ok: false, message: '备份失败，请重试' };
    }
  },

  openFolder: async () => {
    try {
      await window.copilot.historyOpenFolder();
    } catch {
      /* 打开目录失败不是关键路径 */
    }
  },

  setSaveState: (saveState, options) =>
    set({
      saveState,
      saveError: options?.error ?? (saveState === 'failed' ? get().saveError : null),
      savedAt: options?.at ?? get().savedAt,
    }),

  setFactSave: (factSaveState, error) =>
    set({
      factSaveState,
      factSaveError: error ?? (factSaveState === 'failed' ? get().factSaveError : null),
    }),

  setPendingCount: (pendingCount) => set({ pendingCount }),
}));
