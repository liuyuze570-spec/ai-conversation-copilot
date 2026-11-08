import { useCallback, useEffect, useState } from 'react';
import { useConversationStore } from '../stores/conversation';
import { useHistoryStore } from '../stores/history';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { resetLiveSession } from '../lib/session-reset';
import { HISTORY_PAGE_SIZE } from '../../shared/history';
import type { ConversationItem } from '../../shared/types';
import type { HistoryMessage, HistorySession } from '../../shared/history';
import {
  attachHistorySession,
  currentHistorySessionId,
  discardHistorySession,
  retrySave,
  startNewHistorySession,
} from '../lib/history-sync';

/**
 * 会话切换（新建 / 打开 / 删除 / 全部清空）。
 *
 * 和 0.4.0 的区别：记录不再存在渲染层的内存数组里，而是主进程的 SQLite。
 * 所以这里不再有 `saveCurrent(items)` 这种「把整个数组交上去」的调用 ——
 * 那样做等于用当前内存里的一小部分覆盖完整旧会话（内存只留最近 400 条）。
 * 现在每条消息在定稿那一刻就已经写进库了，切会话只需要冲洗待写队列。
 *
 * 四个入口仍然全部走 `resetLiveSession()`：事实卡、在途翻译、朗读都是
 * 按当前会话存在的，只清字幕会让上一场的内容串到新会话里。
 */

/**
 * 把库里的一页消息转成字幕项。顺序严格按 seq 升序。
 *
 * `seq` **必须带出来**：向上翻更早一页的游标就是「当前最早一条的 seq」。
 * 0.5.0 漏了这一个字段，于是 `loadEarlier()` 永远算不出游标、
 * 第 51 条往前的记录在界面上点不出来（数据其实一直在库里）。
 */
export function toConversationItems(messages: HistoryMessage[]): ConversationItem[] {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  return sorted.map((message) => ({
    id: message.id,
    seq: message.seq,
    timestamp: message.ts,
    speaker: message.speaker,
    originalText: message.original,
    translatedText: message.translation || undefined,
    translationState:
      message.state === 'failed'
        ? 'failed'
        : message.state === 'cancelled'
          ? 'cancelled'
          : message.state === 'pending'
            ? 'pending'
            : 'ok',
    translationError: message.translationError,
    confidence: message.confidence,
    partial: message.state === 'partial',
    romanization: message.romanization || undefined,
    // 当年用哪种字系标的读音，原样带回来 —— 不能拿「现在设置里的体系」去重算，
    // 那会把旧记录里正确的汉字近音改写成错误的片假名。
    hintSystem: message.hintSystem,
    hintVersion: message.hintVersion,
    correction: message.correction,
  }));
}

export function useSessions() {
  const sessions = useHistoryStore((state) => state.sessions);
  const total = useHistoryStore((state) => state.total);
  const saveState = useHistoryStore((state) => state.saveState);
  const saveError = useHistoryStore((state) => state.saveError);
  const pendingCount = useHistoryStore((state) => state.pendingCount);

  const clearLive = useCallback(() => {
    resetLiveSession();
    useUiStore.getState().setError(null);
  }, []);

  /** 新建一段对话：先把旧的写干净，再清场。没写成功就不清场。 */
  const newSession = useCallback(async () => {
    const saved = await startNewHistorySession();
    if (!saved) return false;
    clearLive();
    useConversationStore.getState().clear();
    useConversationStore.getState().setHasEarlier(false);
    useHistoryStore.getState().setSaveState('idle');
    return true;
  }, [clearLive]);

  /**
   * 打开一段已保存的记录。
   *
   * 先冲洗当前会话（否则最后几句可能还没落盘），再读这一段的最后一页。
   * 打开之后继续说话会**追加到这段记录**里 —— 那是同一场对话的延续，
   * 新开一段反而会把上下文割裂。
   */
  const openSession = useCallback(
    async (id: string) => {
      const saved = await startNewHistorySession();
      if (!saved) return false;
      const result = await window.copilot.historyPage({ sessionId: id, limit: HISTORY_PAGE_SIZE });
      if (!result.ok) return false;
      const items = toConversationItems(result.data.messages);
      clearLive();
      const store = useConversationStore.getState();
      store.clear();
      store.loadItems(items);
      store.setHasEarlier(result.data.hasMore);
      attachHistorySession(id, items);
      return true;
    },
    [clearLive],
  );

  /** 往上翻时继续加载更早的一页（拼到最前面，顺序稳定）。 */
  const loadEarlier = useCallback(async () => {
    const id = currentHistorySessionId();
    if (!id) return 0;
    const items = useConversationStore.getState().items;
    const seqs = items
      .map((item) => item.seq)
      .filter((seq): seq is number => typeof seq === 'number');
    if (!seqs.length) {
      useConversationStore.getState().setHasEarlier(false);
      return 0;
    }
    // 游标用 seq 而不是时间戳：同一毫秒可能有多条，用时间戳会重复或漏条。
    const beforeSeq = Math.min(...seqs);
    const result = await window.copilot.historyPage({
      sessionId: id,
      beforeSeq,
      limit: HISTORY_PAGE_SIZE,
    });
    if (!result.ok) return 0;
    const older = toConversationItems(result.data.messages);
    useConversationStore.getState().prependItems(older);
    useConversationStore.getState().setHasEarlier(result.data.hasMore);
    return older.length;
  }, []);

  const removeSession = useCallback(
    async (id: string) => {
      const result = await useHistoryStore.getState().remove(id);
      if (currentHistorySessionId() === id) {
        // 正在看的这段被删了：清场，避免界面还留着已经不存在的记录。
        // 这里**不能 flush** —— 那会把刚删掉的内容又写进一个新会话里。
        clearLive();
        useConversationStore.getState().clear();
        discardHistorySession();
      }
      return result;
    },
    [clearLive],
  );

  const clearAllSessions = useCallback(async () => {
    const result = await useHistoryStore.getState().clearAll();
    clearLive();
    useConversationStore.getState().clear();
    // 同上：库已经被清空，再 flush 等于把屏幕上的这几句又存回去。
    discardHistorySession();
    return result;
  }, [clearLive]);

  /*
   * 「上次的那一段」。
   *
   * 关掉软件再打开，字幕区是空的 —— 记录其实好好躺在库里，但第一眼看上去
   * 像丢了。这一条查库里最近的一段，在空状态给一个明确的「打开」入口。
   *
   * 为什么不在启动时直接自动打开：
   * 自动恢复会让人以为「刚才的话还在继续说」，而实际上那是一场已经结束的
   * 对话；更糟的是新说的话会被追加到旧会话里，两条不相干的对话混成一条。
   */
  const [recent, setRecent] = useState<HistorySession | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const result = await window.copilot.historyList({ limit: 1 });
      if (!alive || !result.ok) return;
      const first = result.data.items[0] ?? null;
      setRecent(first && first.messageCount > 0 ? first : null);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const resumeRecent = useCallback(async () => {
    if (!recent) return false;
    return openSession(recent.id);
  }, [recent, openSession]);

  const retry = useCallback(async () => {
    const ok = await retrySave();
    if (ok) useHistoryStore.getState().refreshStatus();
    return ok;
  }, []);

  return {
    sessions,
    total,
    saveState,
    saveError,
    pendingCount,
    activeId: currentHistorySessionId(),
    recent,
    resumeRecent,
    language: useSettingsStore((state) => state.settings.targetLanguage),
    newSession,
    openSession,
    loadEarlier,
    removeSession,
    clearAllSessions,
    retrySave: retry,
  };
}
