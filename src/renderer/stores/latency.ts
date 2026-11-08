import { create } from 'zustand';
import { emptySnapshot, type LatencySnapshot } from '../../shared/latency';

/**
 * 全链路时延的当前快照。
 *
 * 数据源在主进程（它才看得到识别和翻译各自花了多久），这里只是缓存一份给
 * 界面渲染。刻意不在这里算平均值 —— 统计口径都在 shared/latency.ts 的纯函数
 * 里，那样才能被单元测试直接验证。
 */
interface LatencyState {
  snapshot: LatencySnapshot;
  setSnapshot: (snapshot: LatencySnapshot) => void;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
}

export const useLatencyStore = create<LatencyState>((set) => ({
  snapshot: emptySnapshot(),
  setSnapshot: (snapshot) => set({ snapshot }),
  refresh: async () => {
    try {
      set({ snapshot: await window.copilot.latencyGet() });
    } catch {
      // 面板还没打开、或主进程刚起 —— 拿不到就保持现状，不打扰用户。
    }
  },
  clear: async () => {
    try {
      set({ snapshot: await window.copilot.latencyClear() });
    } catch {
      /* 同上 */
    }
  },
}));
