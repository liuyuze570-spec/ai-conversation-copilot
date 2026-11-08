import { contextBridge, ipcRenderer, webFrame } from 'electron';
import {
  IPC,
  type AiKeyInfo,
  type AiTestResult,
  type AudioLevelPayload,
  type AudioProbeResult,
  type AudioStatusPayload,
  type DocKind,
  type OpenDocResult,
  type ShortcutAction,
  type SttLatencyProbe,
  type TranscriptPayload,
} from '../shared/ipc';
import type { LogEntry, LogLevel, Settings } from '../shared/types';
import type { FactItem } from '../shared/facts';
import type { LatencySnapshot } from '../shared/latency';
import { HealthReport } from '../shared/health';
import type {
  HistoryBackupResult,
  HistoryExportResult,
  HistoryFact,
  HistoryMessage,
  HistoryPage,
  HistoryResult,
  HistorySession,
  HistoryStatus,
} from '../shared/history';

/** 文字模型（LLM）和语音识别（STT）可以各用一把 Key。 */
export type KeyTarget = 'llm' | 'stt';

export interface KeyPreview {
  /** 有没有一把「当前服务商能用」的 Key。 */
  present: boolean;
  /** 脱敏后的样子，例如 `sk-a••••9f2c`。**永远不含完整 Key**。 */
  masked: string;
  /** 这把 Key 保存时属于哪台服务器（完整 origin，含协议与端口）。 */
  boundOrigin: string;
  /** 现在设置里的接口地址是哪台服务器。 */
  currentOrigin: string;
  /** ok / mismatch（属于别家）/ unknown（没有归属记录）。 */
  ownership: 'ok' | 'mismatch' | 'unknown';
  /** 两者不一致（切换过服务商，需要重填）。 */
  mismatch: boolean;
  /** 有 Key 但没有任何归属记录 —— 也不能用。 */
  unknown: boolean;
  /** 只在本次运行有效（系统加密不可用），重启要重填。 */
  ephemeral: boolean;
  /** 归属有问题时给用户的一句话（已含「请重新粘贴」的指引）。 */
  message: string;
}

export interface CopilotApi {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /**
   * 密钥的脱敏预览。
   *
   * 刻意不提供「取回完整 Key」的通道：所有网络请求都在主进程发，渲染层拿到
   * 完整 Key 只会扩大暴露面（任何注入到页面的脚本都能读走它）。
   */
  getApiKeyPreview(target?: KeyTarget): Promise<KeyPreview>;
  setApiKey(key: string, target?: KeyTarget): Promise<boolean>;
  hasApiKey(target?: KeyTarget): Promise<boolean>;
  /** 配了哪些 Key、字幕现在能不能工作。 */
  aiKeyInfo(): Promise<AiKeyInfo>;
  /** 真发一次请求，验证「地址 + Key + 模型」。 */
  aiTest(): Promise<AiTestResult>;
  /** 拉取服务商的模型列表。 */
  aiModels(): Promise<{ ok: boolean; models: string[]; message?: string }>;
  /**
   * 打开随软件附带的教学文档。
   * anchor 传教程里的某一节（例如 `provider-zhipu`），浏览器会直接滚到那一段，
   * 省得用户在长教程里自己翻找。
   */
  openDoc(kind?: DocKind, anchor?: string): Promise<OpenDocResult>;
  log(level: LogLevel, scope: string, message: string): void;
  getLogs(count?: number): Promise<LogEntry[]>;
  minimize(): void;
  close(): void;
  setOpacity(opacity: number): void;
  setAlwaysOnTop(enabled: boolean): void;
  setLocked(locked: boolean): void;
  resize(width: number, height: number): void;
  resetWindowPosition(): void;
  onTrayToggleListening(callback: () => void): () => void;
  onShortcut(callback: (action: ShortcutAction) => void): () => void;
  /**
   * 开始采集。
   *
   * `kind` 是真实结果，不是「函数有没有跑完」：
   * - `running`  设备已确认，确实在采；
   * - `skipped`  配置没变、管线本来就在跑（不重复起进程）；
   * - `pending`  进程起来了但设备还没确认（界面应写「正在连接」，不是「正在采集」）；
   * - `failed`   明确失败（含没选音源）。
   */
  audioStart(): Promise<{
    ok: boolean;
    kind: 'running' | 'skipped' | 'pending' | 'cancelled' | 'failed';
    message?: string;
  }>;
  /** 强制重建音频管线（引擎死了 / 换了设备 / 刚插回耳机）。不需要重启软件。 */
  audioReconnect(): Promise<{
    ok: boolean;
    kind: 'running' | 'skipped' | 'pending' | 'cancelled' | 'failed';
    message?: string;
  }>;
  audioStop(): Promise<{ ok: boolean }>;
  audioDevices(): Promise<{ id: string; name: string; kind: 'system' | 'mic' }[]>;
  audioDemoLine(text?: string): Promise<{ ok: boolean; text?: string; message?: string }>;
  /** 跑一组内置样例（预置文本，仅演示模式可用）。 */
  samplesRun(sampleId: string): Promise<{
    ok: boolean;
    text?: string;
    translatedHint?: string;
    message?: string;
  }>;
  audioProbe(mode?: 'loopback' | 'mic'): Promise<AudioProbeResult>;
  /** 一键体检：只返回条目，界面自己筛掉没问题的项。 */
  systemCheck(): Promise<HealthReport>;
  onAudioStatus(callback: (payload: AudioStatusPayload) => void): () => void;
  onAudioLevel(callback: (payload: AudioLevelPayload) => void): () => void;
  /** 丢了一段音频（积压 / 超时 / 失败）—— 字幕流里要留可见标记。 */
  onAudioDropped(callback: (payload: { at: number; reason: string }) => void): () => void;
  onTranscript(callback: (payload: TranscriptPayload) => void): () => void;
  /**
   * 翻译一句。`requestId` 用于取消（见 `aiCancel`）。
   *
   * 停止监听 / 关面板时界面会取消它，主进程会把底层 HTTP 真的掐断。
   */
  aiTranslate(
    text: string,
    context?: string[],
    traceId?: string,
    requestId?: string,
  ): Promise<{
    ok: boolean;
    text: string;
    /** 用户主动取消（不是故障，界面不该报红）。 */
    cancelled?: boolean;
    /** 失败原因：分类 + 一句话 + 可以执行的下一步，**不含**服务商原始响应。 */
    error?: { code: string; title: string; hint: string };
  }>;
  /** 真人朗读音色，`speed` 让「0.7x 慢速」在云端朗读下也生效。 */
  aiTts(text: string, speed?: number, requestId?: string): Promise<string>;
  /**
   * 取消在途的 AI 请求（翻译 / 回复 / 朗读）。
   *
   * 传 requestId（或一串）。取消是幂等的：请求已经结束就什么也不做。
   */
  aiCancel(requestIds: string | string[]): Promise<{ cancelled: number }>;
  // ---- 聊天记录（主进程 SQLite，长期保存）-------------------------------
  historyStatus(): Promise<HistoryResult<HistoryStatus>>;
  historyEnsureSession(payload: {
    id: string;
    language: string;
    scenario: string;
    sourceMode: string;
    /** 理解语言（译文用哪种）。旧调用方不传也没关系。 */
    comprehension?: string;
    /** 读音提示体系。要跟着会话存下来，否则换了理解语言后旧记录会串。 */
    hintSystem?: string;
  }): Promise<HistoryResult<HistorySession>>;
  historyUpsert(payload: {
    sessionId: string;
    messages: HistoryMessage[];
  }): Promise<HistoryResult<{ written: number; session: HistorySession | null }>>;
  historySaveFacts(payload: {
    sessionId: string;
    facts: HistoryFact[];
    /** 用户删掉的事实 id：要真的从库里删，否则重开又回来。 */
    removedIds?: string[];
  }): Promise<HistoryResult<{ written: number }>>;
  historyList(payload?: {
    limit?: number;
    offset?: number;
  }): Promise<HistoryResult<{ items: HistorySession[]; total: number }>>;
  historyPage(payload: {
    sessionId: string;
    beforeSeq?: number | null;
    limit?: number;
  }): Promise<HistoryResult<HistoryPage>>;
  historySearch(payload: {
    query: string;
    limit?: number;
  }): Promise<
    HistoryResult<{ items: (HistorySession & { snippet: string; hits: number })[]; total: number }>
  >;
  historyRename(payload: { id: string; title: string }): Promise<HistoryResult<{ ok: boolean }>>;
  historyDelete(payload: { id: string }): Promise<HistoryResult<{ ok: boolean }>>;
  historyClear(): Promise<HistoryResult<{ sessions: number; messages: number }>>;
  historyExport(payload?: {
    sessionId?: string;
    format?: 'text' | 'json';
  }): Promise<HistoryResult<HistoryExportResult>>;
  historyBackup(): Promise<HistoryResult<HistoryBackupResult>>;
  historyOpenFolder(): Promise<HistoryResult<{ ok: boolean; dir: string }>>;
  /**
   * 从一句定稿字幕里提取「关键事实」。
   *
   * 失败会返回 `{ok:false}`，**不会**抛错 —— 事实卡是锦上添花，
   * 不能因为它把字幕主流程弄断。
   */
  factsExtract(payload: {
    itemId: string;
    originalText: string;
    translatedText?: string;
    language: string;
    roundIndex: number;
    requestId?: string;
  }): Promise<{ ok: boolean; facts: FactItem[]; message?: string; cancelled?: boolean }>;
  /** 把选中的事实写成一句确认用语 + 中文意思。 */
  aiConfirm(payload: {
    facts: FactItem[];
    language: string;
    requestId?: string;
  }): Promise<{ ok: boolean; sentence: string; chinese: string; message?: string }>;
  aiReply(payload: {
    context: string;
    mode: string;
    current?: string;
    chinese?: string;
    tone?: string;
    scenario?: string;
    /** 这一次请求的编号，用于作废「上一轮还没回来的」请求。 */
    requestId?: string;
  }): Promise<string>;
  aiStt(audioBase64: string, mime: string, prompt?: string): Promise<string>;
  /** 全链路时延：拉一次当前快照 / 清空重新测 / 订阅变化。 */
  latencyGet(): Promise<LatencySnapshot>;
  latencyClear(): Promise<LatencySnapshot>;
  onLatency(callback: (snapshot: LatencySnapshot) => void): () => void;
  /** 主动测一次真实识别的往返耗时（不依赖声卡）。 */
  latencyProbeStt(): Promise<SttLatencyProbe>;
  isDev: boolean;
}

const api: CopilotApi = {
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  getApiKeyPreview: (target = 'llm') => ipcRenderer.invoke(IPC.KEY_PREVIEW, target),
  setApiKey: (key, target = 'llm') => ipcRenderer.invoke(IPC.KEY_SET, key, target),
  hasApiKey: (target = 'llm') => ipcRenderer.invoke(IPC.KEY_HAS, target),
  aiKeyInfo: () => ipcRenderer.invoke(IPC.AI_KEY_INFO),
  aiTest: () => ipcRenderer.invoke(IPC.AI_TEST),
  aiModels: () => ipcRenderer.invoke(IPC.AI_MODELS),
  openDoc: (kind = 'tutorial', anchor) => ipcRenderer.invoke(IPC.DOC_OPEN, kind, anchor),
  log: (level, scope, message) => ipcRenderer.send(IPC.LOG, level, scope, message),
  getLogs: (count = 100) => ipcRenderer.invoke(IPC.LOG_TAIL, count),
  minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
  setOpacity: (opacity) => ipcRenderer.send(IPC.WINDOW_SET_OPACITY, opacity),
  setAlwaysOnTop: (enabled) => ipcRenderer.send(IPC.WINDOW_SET_ALWAYS_ON_TOP, enabled),
  setLocked: (locked) => ipcRenderer.send(IPC.WINDOW_SET_LOCKED, locked),
  resize: (width, height) => ipcRenderer.send(IPC.WINDOW_SET_SIZE, width, height),
  resetWindowPosition: () => ipcRenderer.send(IPC.WINDOW_RESET_POSITION),
  onTrayToggleListening: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC.TRAY_TOGGLE_LISTENING, handler);
    return () => ipcRenderer.removeListener(IPC.TRAY_TOGGLE_LISTENING, handler);
  },
  onShortcut: (callback) => {
    const handler = (_event: unknown, action: ShortcutAction) => callback(action);
    ipcRenderer.on(IPC.SHORTCUT_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC.SHORTCUT_EVENT, handler);
  },
  audioStart: () => ipcRenderer.invoke(IPC.AUDIO_START),
  audioReconnect: () => ipcRenderer.invoke(IPC.AUDIO_RECONNECT),
  audioStop: () => ipcRenderer.invoke(IPC.AUDIO_STOP),
  audioDevices: () => ipcRenderer.invoke(IPC.AUDIO_DEVICES),
  audioDemoLine: (text?: string) => ipcRenderer.invoke(IPC.AUDIO_DEMO_LINE, text),
  samplesRun: (sampleId) => ipcRenderer.invoke(IPC.SAMPLES_RUN, sampleId),
  audioProbe: (mode = 'loopback') => ipcRenderer.invoke(IPC.AUDIO_PROBE, mode),
  systemCheck: () => ipcRenderer.invoke(IPC.SYSTEM_CHECK),
  onAudioStatus: (callback) => {
    const handler = (_event: unknown, payload: AudioStatusPayload) => callback(payload);
    ipcRenderer.on(IPC.AUDIO_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_STATUS, handler);
  },
  onAudioLevel: (callback) => {
    const handler = (_event: unknown, payload: AudioLevelPayload) => callback(payload);
    ipcRenderer.on(IPC.AUDIO_LEVEL, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_LEVEL, handler);
  },
  onAudioDropped: (callback) => {
    const handler = (_event: unknown, payload: { at: number; reason: string }) => callback(payload);
    ipcRenderer.on(IPC.AUDIO_DROPPED, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_DROPPED, handler);
  },
  onTranscript: (callback) => {
    const handler = (_event: unknown, payload: TranscriptPayload) => callback(payload);
    ipcRenderer.on(IPC.AUDIO_TRANSCRIPT, handler);
    return () => ipcRenderer.removeListener(IPC.AUDIO_TRANSCRIPT, handler);
  },
  aiTranslate: (text, context = [], traceId, requestId) =>
    ipcRenderer.invoke('ai:translate', text, context, traceId, requestId),
  aiTts: (text, speed, requestId) => ipcRenderer.invoke('ai:tts', text, speed, requestId),
  aiCancel: (requestIds) => ipcRenderer.invoke(IPC.AI_CANCEL, requestIds),
  factsExtract: (payload) => ipcRenderer.invoke(IPC.FACTS_EXTRACT, payload),
  aiConfirm: (payload) => ipcRenderer.invoke(IPC.AI_CONFIRM, payload),
  aiReply: (payload) => ipcRenderer.invoke('ai:reply', payload),
  aiStt: (audioBase64, mime, prompt) =>
    ipcRenderer.invoke('ai:stt', audioBase64, mime, prompt),
  latencyGet: () => ipcRenderer.invoke(IPC.LATENCY_GET),
  latencyClear: () => ipcRenderer.invoke(IPC.LATENCY_CLEAR),
  latencyProbeStt: () => ipcRenderer.invoke(IPC.LATENCY_PROBE_STT),
  onLatency: (callback) => {
    const handler = (_event: unknown, snapshot: LatencySnapshot) => callback(snapshot);
    ipcRenderer.on(IPC.LATENCY_PUSH, handler);
    return () => ipcRenderer.removeListener(IPC.LATENCY_PUSH, handler);
  },
  isDev: process.env.NODE_ENV === 'development',
  // ---- 聊天记录 ---------------------------------------------------------
  historyStatus: () => ipcRenderer.invoke(IPC.HISTORY_STATUS),
  historyEnsureSession: (payload) => ipcRenderer.invoke(IPC.HISTORY_ENSURE_SESSION, payload),
  historyUpsert: (payload) => ipcRenderer.invoke(IPC.HISTORY_UPSERT, payload),
  historySaveFacts: (payload) => ipcRenderer.invoke(IPC.HISTORY_SAVE_FACTS, payload),
  historyList: (payload) => ipcRenderer.invoke(IPC.HISTORY_LIST, payload ?? {}),
  historyPage: (payload) => ipcRenderer.invoke(IPC.HISTORY_PAGE, payload),
  historySearch: (payload) => ipcRenderer.invoke(IPC.HISTORY_SEARCH, payload),
  historyRename: (payload) => ipcRenderer.invoke(IPC.HISTORY_RENAME, payload),
  historyDelete: (payload) => ipcRenderer.invoke(IPC.HISTORY_DELETE, payload),
  historyClear: () => ipcRenderer.invoke(IPC.HISTORY_CLEAR),
  historyExport: (payload) => ipcRenderer.invoke(IPC.HISTORY_EXPORT, payload ?? {}),
  historyBackup: () => ipcRenderer.invoke(IPC.HISTORY_BACKUP),
  historyOpenFolder: () => ipcRenderer.invoke(IPC.HISTORY_OPEN_FOLDER),
};

contextBridge.exposeInMainWorld('copilot', api);

// Prevent the transparent overlay from being zoomed by the OS scaling oddities.
webFrame.setVisualZoomLevelLimits(1, 1);
