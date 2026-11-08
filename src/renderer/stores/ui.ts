import { create } from 'zustand';
import type { ListeningStatus, ReplySuggestion } from '../../shared/types';
import type { AudioLevelPayload } from '../../shared/ipc';
import { panelsAfterReplies } from '../../shared/reply-reveal';

type ReplyMode =
  | 'reply'
  | 'simple'
  | 'natural'
  | 'continue'
  | 'rephrase'
  | 'simplify'
  | 'didnt-catch'
  | 'from-chinese';

interface UiState {
  status: ListeningStatus;
  statusMessage: string;
  suggestions: ReplySuggestion[];
  /**
   * 当前这三张回复卡是针对第几轮生成的。
   *
   * 新一轮开始后它就会小于 conversation.roundIndex —— 界面据此提示「这些回复
   * 说的是上一轮」。没有这个字段时，旧卡片会一直挂在那里，用户以为新一轮
   * 没被监听。
   */
  repliesRound: number | null;
  busy: boolean;
  error: string | null;
  showSettings: boolean;
  showPrivacy: boolean;
  showRecords: boolean;
  speakingId: string | null;
  lastMode: ReplyMode | null;
  /**
   * Whether the thing being listened to is still running. In video / exam
   * scenario this flips to `paused` when the other side stops talking, which
   * is what triggers the automatic reply.
   */
  playback: 'playing' | 'paused';
  setPlayback: (playback: 'playing' | 'paused') => void;
  /**
   * Latest loudness reading from the capture sidecar. `levelAt` lets the UI
   * notice that readings stopped (engine died) instead of showing a frozen bar.
   */
  level: AudioLevelPayload | null;
  levelAt: number;
  /**
   * Last time a real signal arrived. Diagnostics use this instead of the
   * instantaneous level, otherwise a normal pause between sentences flips the
   * panel to "I hear nothing" and back again.
   */
  heardAt: number;
  setLevel: (level: AudioLevelPayload | null) => void;
  setStatus: (status: ListeningStatus, message?: string) => void;
  setSuggestions: (
    suggestions: ReplySuggestion[],
    round?: number,
    opts?: { reveal?: boolean },
  ) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  toggleSettings: (value?: boolean) => void;
  setShowPrivacy: (value: boolean) => void;
  toggleRecords: (value?: boolean) => void;
  setSpeakingId: (id: string | null) => void;
  setLastMode: (mode: ReplyMode) => void;
}

export const useUiStore = create<UiState>((set) => ({
  status: 'idle',
  statusMessage: '',
  suggestions: [],
  repliesRound: null,
  busy: false,
  error: null,
  showSettings: false,
  showPrivacy: false,
  showRecords: false,
  speakingId: null,
  lastMode: null,
  playback: 'playing',
  setPlayback: (playback) => set({ playback }),
  level: null,
  levelAt: 0,
  heardAt: 0,
  setLevel: (level) =>
    set((state) => ({
      level,
      levelAt: Date.now(),
      heardAt: level && level.db > -95 ? Date.now() : state.heardAt,
    })),
  setStatus: (status, message = '') => set({ status, statusMessage: message }),
  setSuggestions: (suggestions, round, opts) =>
    set((state) => {
      // 面板要不要被这批回复收掉，规则独立在 shared/reply-reveal.ts 里 ——
      // 那里解释了为什么「自动来的回复」不许抢用户手里打开的面板。
      const panels = panelsAfterReplies(
        { showSettings: state.showSettings, showRecords: state.showRecords },
        suggestions.length,
        opts?.reveal ?? true,
      );
      return {
        suggestions,
        // 清空时不保留轮次，否则下次开面板会瞬间显示「过时」。
        repliesRound: suggestions.length ? (round ?? state.repliesRound) : null,
        ...panels,
      };
    }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  toggleSettings: (value) =>
    set((state) => {
      const next = value ?? !state.showSettings;
      // 谁动了设置面板要留痕：面板自己弹出来过，光看 UI 查不出是谁点的。
      try {
        window.copilot?.log?.('INFO', 'Panel', `settings -> ${next}`);
      } catch {
        /* ignore */
      }
      return { showSettings: next };
    }),
  setShowPrivacy: (value) => set({ showPrivacy: value }),
  toggleRecords: (value) => set((state) => ({ showRecords: value ?? !state.showRecords })),
  setSpeakingId: (id) => set({ speakingId: id }),
  setLastMode: (mode) => set({ lastMode: mode }),
}));
