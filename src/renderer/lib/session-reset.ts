/**
 * 「清掉当前这场对话」的唯一入口。
 *
 * 为什么不能只靠 useSessions 的返回值：`useSessions()` 被两个组件各自调用
 * （App 和 RecordsPanel），每个实例的返回值互不相关。一开始把清场回调做成
 * `useSessions(resetLive)` 的参数，结果 RecordsPanel 那份实例没传参数，
 * 从记录面板点「新增对话记录」只清了字幕 —— 上一场的「明天下午三点」还挂在
 * 新的空白会话上。自检里就是这么被抓到的（factsAfterNewSession=6）。
 *
 * 所以改成模块级单例：真正的实现由 `useCopilot()` 注册一次（它才持有那些
 * 在途请求的引用），任何地方调用 `resetLiveSession()` 都走同一条路。
 */
import { useConversationStore } from '../stores/conversation';
import { useFactsStore } from '../stores/facts';
import { useUiStore } from '../stores/ui';

type ResetHandler = () => void;

let handler: ResetHandler | null = null;

/** 由 useCopilot 注册真正的实现，返回注销函数（卸载时用）。 */
export function registerSessionReset(fn: ResetHandler): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/**
 * 清空当前对话：取消在途的翻译 / 回复 / 朗读 / 事实提取，清事实卡与字幕。
 *
 * 兜底分支只在 useCopilot 尚未挂载时才会走到（实际上不存在），但至少不会崩，
 * 也不会留下事实卡 —— 宁可少清一个在途请求，也不能让上一场的关键信息串过来。
 */
export function resetLiveSession(): void {
  if (handler) {
    handler();
    return;
  }
  useConversationStore.getState().clear();
  useFactsStore.getState().clear();
  useUiStore.getState().setSuggestions([]);
}
