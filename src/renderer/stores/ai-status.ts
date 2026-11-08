import { create } from 'zustand';
import type { AiKeyInfo, AiTestResult } from '../../shared/ipc';

/**
 * 模型连接的当前状态。
 *
 * 设置页和标题栏都要显示「到底连没连上」，而测试连接是一次真实的网络
 * 请求，不能每次渲染都发一遍，所以把结果存在这里共享。
 */
interface AiStatusState {
  keyInfo: AiKeyInfo | null;
  test: AiTestResult | null;
  testing: boolean;
  /** 上次测试的时间，用于显示「刚刚测过」。 */
  testedAt: number;
  refreshKeys: () => Promise<void>;
  runTest: () => Promise<AiTestResult>;
  setTest: (test: AiTestResult | null) => void;
}

export const useAiStatusStore = create<AiStatusState>((set) => ({
  keyInfo: null,
  test: null,
  testing: false,
  testedAt: 0,

  refreshKeys: async () => {
    try {
      set({ keyInfo: await window.copilot.aiKeyInfo() });
    } catch {
      set({ keyInfo: null });
    }
  },

  runTest: async () => {
    set({ testing: true, test: null });
    try {
      const result = await window.copilot.aiTest();
      set({ test: result, testedAt: Date.now() });
      return result;
    } finally {
      set({ testing: false });
    }
  },

  setTest: (test) => set({ test }),
}));
