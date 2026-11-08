import { create } from 'zustand';
import type { FactItem } from '../../shared/facts';

/**
 * 关键事实卡的内存存储。
 *
 * 只活在当前会话：不写磁盘、不进日志、切换 / 清空对话就整个丢掉
 * （审计要求「事实卡默认只保存在当前会话内存」「新建会话或清空记录时同步
 * 清理事实和在途任务」）。
 */

/** 上限：一场两小时的会也够用，又不会让内存无界增长。 */
const MAX_FACTS = 300;

interface FactsState {
  items: FactItem[];
  /** 勾选了哪些（生成确认句只用这些）。 */
  selected: Record<string, true>;
  /** 正在生成确认句。 */
  confirming: boolean;
  /** 最近一次生成结果（用户可复制 / 朗读）。 */
  draft: { sentence: string; chinese: string; factIds: string[] } | null;
  /** 生成失败的一句话。 */
  error: string | null;
  /**
   * 事实快照的版本号，任何会影响确认句的改动都会 +1。
   *
   * 在途请求回来时拿它比：版本变了就说明用户在这期间改了值 / 删了行 /
   * 换了勾选，结果已经不对应当前事实，必须丢掉 —— 不能让一句基于旧值的
   * 确认句盖到界面上。
   */
  version: number;

  /** 新的一批事实（同一条字幕重复提取时按内容去重）。 */
  addMany: (items: FactItem[]) => void;
  /**
   * 用「最新一次的规则结果」替换这条字幕之前的规则结果。
   *
   * 为什么需要：同一条字幕会被提取两次 —— 定稿时只有原文，译文回来后还要
   * 再跑一次（中文里的「明天下午三点」只有这时才认得出）。如果只是追加，
   * 界面就会出现
   *     日期  Tomorrow   ← 第一次留下的
   *     日期  明天       ← 第二次合并后的（片段是 Tomorrow）
   * 同一件事两行。规则事实以最后一次为准；用户手动改过 / 确认过的行保留，
   * 不能被自动结果覆盖掉。
   */
  replaceRuleFacts: (itemId: string, items: FactItem[]) => void;
  update: (id: string, patch: { value?: string; status?: FactItem['status']; spoken?: string }) => void;
  remove: (id: string) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  setConfirming: (value: boolean) => void;
  setDraft: (draft: FactsState['draft']) => void;
  setError: (message: string | null) => void;
  /** 清空（新建会话 / 清空记录 / 停止监听时调用）。 */
  clear: () => void;
  forItem: (itemId: string) => FactItem[];
}

export const useFactsStore = create<FactsState>((set, get) => ({
  items: [],
  selected: {},
  confirming: false,
  draft: null,
  error: null,
  version: 0,

  addMany: (incoming) => {
    if (!incoming.length) return;
    const { items } = get();
    const seen = new Set(
      items.map((item) => `${item.kind}|${item.value.trim().toLowerCase()}|${item.itemId}`),
    );
    const fresh: FactItem[] = [];
    for (const item of incoming) {
      const key = `${item.kind}|${item.value.trim().toLowerCase()}|${item.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(item);
    }
    if (!fresh.length) return;
    set({ items: [...items, ...fresh].slice(-MAX_FACTS), version: get().version + 1 });
  },

  replaceRuleFacts: (itemId, incoming) => {
    const state = get();
    /*
     * 只替换「还保持自动态」的行：用户改过值（edited）或确认过（confirmed）
     * 的一律原样留着 —— 自动提取没有资格覆盖人的判断。
     */
    const keepOthers = state.items.filter(
      (item) =>
        !(
          item.itemId === itemId &&
          item.id.startsWith('fr-') &&
          !item.edited &&
          item.status === 'pending'
        ),
    );
    const droppedIds = new Set(
      state.items
        .filter(
          (item) =>
            item.itemId === itemId &&
            item.id.startsWith('fr-') &&
            !item.edited &&
            item.status === 'pending',
        )
        .map((item) => item.id),
    );
    const seen = new Set(
      keepOthers.map((item) => `${item.kind}|${item.value.trim().toLowerCase()}|${item.itemId}`),
    );
    const fresh = incoming.filter((item) => {
      const key = `${item.kind}|${item.value.trim().toLowerCase()}|${item.itemId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const selected = { ...state.selected };
    for (const id of droppedIds) delete selected[id];
    const draft =
      state.draft && state.draft.factIds.some((id) => droppedIds.has(id)) ? null : state.draft;
    set({
      items: [...keepOthers, ...fresh].slice(-MAX_FACTS),
      selected,
      draft,
      version: state.version + 1,
    });
  },

  update: (id, patch) =>
    set((state) => {
      let touched = false;
      let contentChanged = false;
      const items = state.items.map((item) => {
        if (item.id !== id) return item;
        const next: FactItem = { ...item };
        if (typeof patch.value === 'string') {
          const value = patch.value.trim();
          // 空值和「没改」都不算一次修改，不动时间线。
          if (!value || value === item.value) return item;
          // 记住改之前的样子：更正信息时要保留来源与「已修改」提示。
          if (!next.edited) next.originalValue = item.value;
          next.value = value;
          next.edited = true;
          // 值改了，之前那条「现在怎么说」就不再成立，必须重新推导或重填。
          next.spoken = undefined;
          next.spokenSource = undefined;
          next.log = [
            ...(next.log ?? []),
            { at: Date.now(), action: 'edited', from: item.value, to: value },
          ];
          /*
           * 改过的事实必须重新核对。
           *
           * 旧实现只改 value，status 还是 confirmed、confirmedAt 还是上一次
           * 的时间 —— 用户改了金额，卡片还挂着「已确认」，等于拿旧确认给新
           * 值背书。现在改值一律回到待核对，并留下一条取消确认的记录。
           */
          if (item.status === 'confirmed' || item.confirmedAt) {
            next.log = [...next.log, { at: Date.now(), action: 'unconfirmed' }];
          }
          next.status = 'pending';
          next.confirmedAt = undefined;
          touched = true;
          contentChanged = true;
        }
        if (typeof patch.spoken === 'string') {
          const spoken = patch.spoken.trim();
          if (!spoken || spoken === item.spoken) return item;
          next.spoken = spoken;
          next.spokenSource = 'user';
          // 换了一句要对对方念的话，等于换了内容，确认要重来。
          next.status = 'pending';
          next.confirmedAt = undefined;
          touched = true;
          contentChanged = true;
        }
        if (patch.status) {
          const same = patch.status === item.status;
          if (same && !(patch.status === 'pending' && item.confirmedAt)) return item;
          next.status = patch.status;
          // 自动提取成功 ≠ 双方确认成功：确认时刻必须由用户点出来。
          next.confirmedAt = patch.status === 'confirmed' ? Date.now() : undefined;
          next.log = [
            ...(next.log ?? []),
            { at: Date.now(), action: patch.status === 'confirmed' ? 'confirmed' : 'unconfirmed' },
          ];
          touched = true;
        }
        return next;
      });
      if (!touched) return state;
      return {
        items,
        version: state.version + 1,
        // 改内容才让确认句失效；只是点「确认」不该把刚生成的句子清掉。
        draft: contentChanged ? null : state.draft,
        error: contentChanged ? null : state.error,
      };
    }),

  remove: (id) =>
    set((state) => {
      const selected = { ...state.selected };
      delete selected[id];
      return {
        items: state.items.filter((item) => item.id !== id),
        selected,
        version: state.version + 1,
        // 删掉的那条如果正好在确认句里，结果也不再成立。
        draft: state.draft?.factIds.includes(id) ? null : state.draft,
      };
    }),

  toggleSelected: (id) =>
    set((state) => {
      const selected = { ...state.selected };
      if (selected[id]) delete selected[id];
      else selected[id] = true;
      // 选中内容变了，上一次的确认句就不再对应，避免用户复制到旧句子。
      return { selected, draft: null, error: null, version: state.version + 1 };
    }),

  clearSelection: () => set((state) => ({ selected: {}, draft: null, error: null, version: state.version + 1 })),

  setConfirming: (confirming) => set({ confirming }),
  setDraft: (draft) => set({ draft }),
  setError: (error) => set({ error }),

  clear: () =>
    set((state) => ({ items: [], selected: {}, confirming: false, draft: null, error: null, version: state.version + 1 })),

  forItem: (itemId) => get().items.filter((item) => item.itemId === itemId),
}));
