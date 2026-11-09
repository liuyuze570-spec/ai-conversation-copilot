import { create } from 'zustand';
import {
  ApiError,
  createSession,
  getHealth,
  reply as apiReply,
  transcribe as apiTranscribe,
  translate as apiTranslate,
  type Health,
  type TranslateMode,
  type TranscribeMode,
} from './api';
import {
  analyze,
  confirm,
  editRow,
  setSpoken,
  toggleRow,
  type FactRow,
} from './lib/pipeline';
import type { ConfirmPlan } from '@shared/facts';
import { checkNumericConsistency, type NumericCheck } from '@shared/numeric-check';

export type Stage = 'idle' | 'translating' | 'transcribing' | 'replying';
export type SourceKind = 'text' | 'mic' | 'file' | 'preset';

export interface Notice {
  kind: 'info' | 'error' | 'warn';
  text: string;
}

interface State {
  health: Health | null;
  healthError: string | null;
  stage: Stage;
  notice: Notice | null;
  original: string;
  translation: string;
  translateMode: TranslateMode | 'preset' | null;
  transcribeMode: TranscribeMode | null;
  source: SourceKind | null;
  /** 真实耗时，来自后端；预置样例没有这个值。 */
  elapsedMs: number | null;
  requestId: string | null;
  facts: FactRow[];
  plan: ConfirmPlan | null;
  /**
   * 原文与译文的关键信息比对结果。
   *
   * 不是「翻译质量评分」：只查数字、时间、星期、否定这四类会直接害人的东西。
   * `warn` 时界面必须显著提示「按原文核对」，而不是让用户默认译文可信。
   */
  numericCheck: NumericCheck | null;
  replyText: string;
  replyMode: TranslateMode | null;
  version: number;

  init: () => Promise<void>;
  setOriginal: (text: string) => void;
  translate: (text: string, source: SourceKind, presetTranslation?: string) => Promise<void>;
  transcribe: (blob: Blob, filename: string) => Promise<void>;
  askReply: () => Promise<void>;
  editFact: (id: string, value: string) => void;
  speakFact: (id: string, value: string) => void;
  toggleFact: (id: string) => void;
  buildConfirm: () => void;
  clear: () => void;
  dismissNotice: () => void;
}

/** 在途请求的取消句柄：任何新请求先取消旧的，避免过期结果写进界面。 */
let inflight: AbortController | null = null;

function cancelInflight() {
  if (inflight) {
    inflight.abort();
    inflight = null;
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'QUOTA_EXCEEDED':
        return '匿名访问的免费次数用完了（服务端按会话计数）。可以稍后再试，或改用预置样例。';
      case 'RATE_LIMITED':
        return '请求太频繁，服务端限流了。等几秒再试。';
      case 'TOO_LARGE':
        return '这段录音太大了，服务端拒绝接收。换短一点的片段。';
      case 'UNSUPPORTED_AUDIO':
        return '这个音频格式服务端解不了，换成 mp3 / wav / webm / m4a 再试。';
      case 'NOT_CONFIGURED':
        return '服务端没有配置这条能力（既没有本地模型也没有模型接口）。';
      case 'MODE_DISABLED':
        return '运营方已关闭真实模型调用，现在只能用预置样例。';
      case 'NO_PRESET':
        return '演示模式下没有这句的预置译文，换一句或等服务端接上真实模型。';
      case 'SESSION_REQUIRED':
        return '会话过期了，刷新页面会重新建立匿名会话。';
      case 'UPSTREAM_TIMEOUT':
        return '上游模型超时。可以重试一次；连续超时就先用文字输入。';
      case 'UPSTREAM_ERROR':
        return '上游模型返回错误（服务端已把正文过滤掉，只留错误码）。';
      default:
        return `请求失败（${error.code}${error.status ? ` / HTTP ${error.status}` : ''}）。`;
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  return '请求没发出去，检查一下网络。';
}

export const useApp = create<State>((set, get) => ({
  health: null,
  healthError: null,
  stage: 'idle',
  notice: null,
  original: '',
  translation: '',
  translateMode: null,
  transcribeMode: null,
  source: null,
  elapsedMs: null,
  requestId: null,
  facts: [],
  plan: null,
  numericCheck: null,
  replyText: '',
  replyMode: null,
  version: 0,

  init: async () => {
    try {
      const health = await getHealth();
      set({ health, healthError: null });
      await createSession();
    } catch (error) {
      // 健康检查失败不阻塞界面：文字输入与预置样例仍然可用。
      set({ healthError: describe(error) || '服务端不可达' });
    }
  },

  setOriginal: (text) => set({ original: text }),

  translate: async (text, source, presetTranslation) => {
    const next = get().version + 1;
    cancelInflight();
    set({
      version: next,
      stage: 'translating',
      notice: null,
      original: text,
      translation: '',
      translateMode: null,
      source,
      elapsedMs: null,
      requestId: null,
      facts: [],
      plan: null,
      numericCheck: null,
      replyText: '',
      replyMode: null,
    });

    if (presetTranslation) {
      // 预置样例：明确标成 preset，不经过任何模型，也不显示耗时。
      set({
        stage: 'idle',
        translation: presetTranslation,
        translateMode: 'preset',
        facts: analyze(text, presetTranslation),
        numericCheck: checkNumericConsistency(text, presetTranslation),
      });
      return;
    }

    const controller = new AbortController();
    inflight = controller;
    try {
      const result = await apiTranslate(text, controller.signal);
      if (get().version !== next) return;
      set({
        stage: 'idle',
        translation: result.translation,
        translateMode: result.mode,
        elapsedMs: result.elapsed_ms,
        requestId: result.request_id,
        facts: analyze(text, result.translation),
        numericCheck: checkNumericConsistency(text, result.translation),
      });
    } catch (error) {
      if (get().version !== next) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      set({ stage: 'idle', notice: { kind: 'error', text: describe(error) } });
    } finally {
      if (inflight === controller) inflight = null;
    }
  },

  transcribe: async (blob, filename) => {
    const next = get().version + 1;
    cancelInflight();
    set({
      version: next,
      stage: 'transcribing',
      notice: null,
      facts: [],
      plan: null,
      translation: '',
      translateMode: null,
      transcribeMode: null,
      elapsedMs: null,
      requestId: null,
      replyText: '',
      replyMode: null,
    });
    const controller = new AbortController();
    inflight = controller;
    try {
      const heard = await apiTranscribe(blob, filename, controller.signal);
      if (get().version !== next) return;
      set({
        original: heard.text,
        transcribeMode: heard.mode,
        source: 'mic',
        elapsedMs: heard.elapsed_ms,
        requestId: heard.request_id,
      });
      if (!heard.text.trim()) {
        set({ stage: 'idle', notice: { kind: 'warn', text: '这段录音里没识别出文字，换一段或改用文字输入。' } });
        return;
      }
      // 识别完立刻走翻译；两个阶段各自有自己的模式标签，不合并成一个「成功」。
      await get().translate(heard.text, 'mic');
    } catch (error) {
      if (get().version !== next) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      set({ stage: 'idle', notice: { kind: 'error', text: describe(error) } });
    } finally {
      if (inflight === controller) inflight = null;
    }
  },

  askReply: async () => {
    const { original, translation, version } = get();
    if (!original.trim()) return;
    const next = version + 1;
    cancelInflight();
    set({ version: next, stage: 'replying', notice: null });
    const controller = new AbortController();
    inflight = controller;
    try {
      const result = await apiReply(original, translation, controller.signal);
      if (get().version !== next) return;
      set({
        stage: 'idle',
        replyText: result.reply,
        replyMode: result.mode,
      });
    } catch (error) {
      if (get().version !== next) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      set({ stage: 'idle', notice: { kind: 'error', text: describe(error) } });
    } finally {
      if (inflight === controller) inflight = null;
    }
  },

  editFact: (id, value) => {
    const facts = editRow(get().facts, id, value);
    set({ facts, plan: null });
  },

  speakFact: (id, value) => {
    set({ facts: setSpoken(get().facts, id, value), plan: null });
  },

  toggleFact: (id) => set({ facts: toggleRow(get().facts, id), plan: null }),

  buildConfirm: () => set({ plan: confirm(get().facts) }),

  clear: () => {
    cancelInflight();
    set({
      version: get().version + 1,
      stage: 'idle',
      original: '',
      translation: '',
      translateMode: null,
      transcribeMode: null,
      source: null,
      facts: [],
      plan: null,
      numericCheck: null,
      replyText: '',
      replyMode: null,
      elapsedMs: null,
      requestId: null,
      notice: null,
    });
  },

  dismissNotice: () => set({ notice: null }),
}));
