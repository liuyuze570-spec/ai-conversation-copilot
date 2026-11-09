import { create } from 'zustand';
import {
  ApiError,
  ensureSession,
  getHealth,
  reply as apiReply,
  transcribe as apiTranscribe,
  translate as apiTranslate,
  withSession,
  type Health,
  type SourceLanguage,
  type ReplySuggestion,
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
import { planReplies, type PlannedReply } from '@shared/reply-plan';
import { transliterate } from '@services/pronunciation';
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
  /**
   * 匿名会话的准备状态。
   *
   * `pending` 时真实调用按钮必须不可提交：健康徽标只证明进程活着，
   * 不证明「这一趟请求带得回一个服务端认识的会话」。上一版正是把这两件事
   * 混在一起，才出现「页面看起来正常，一点就提示会话过期」。
   */
  sessionState: 'pending' | 'ready' | 'failed';
  sessionError: string | null;
  /** 对方说的是哪种语言。中文永远在译文一侧，这里只管源语言。 */
  sourceLang: SourceLanguage;
  stage: Stage;
  notice: Notice | null;
  original: string;
  translation: string;
  translateMode: TranslateMode | 'preset' | null;
  /** 常用语库命中时：整句译文还是单词词义。 */
  translateNote: 'sentence' | 'word' | null;
  /** 命中来自拼写变体（hellow → hello），界面要说明「按 hello 理解」。 */
  translateCorrected: boolean;
  /** 命中的归一化写法，用来在提示里点名。 */
  translateMatched: string | null;
  /** 日/韩/俄走「→英→中」两级时，中间那句英语（用于说明转译路径）。 */
  translateVia: string | null;
  /** 服务端对译文的修正说明（空数组表示没有）。 */
  translateCorrections: string[];
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
  /** 三条候选回复。第一条与 replyText 相同，保留后者兼容旧渲染。 */
  replies: ReplySuggestion[];
  /**
   * 回复卡（结构化：用途 + 英文 + 中文 + 分段近音 + 操作）。
   *
   * 与 `replies` 并存：`replies` 是服务端/AI 那条路的原始返回，
   * `replyCards` 是界面真正渲染的东西。没有可用模型时，这里由
   * `planReplies()` 按当前事实**本地**拼出来（断网也有）。
   */
  replyCards: PlannedReply[];
  /** 最近几句原文，供回复卡判断话题；手动输入时为空。 */
  replyContext: string[];
  /** 标签页整段译文直接生成回复：不再翻一次，但要把全量上下文带进来。 */
  usePassageForReply: (text: string, translation: string, context: string[]) => void;
  /** 用户改过的回复：中文不再是原句的意思，界面要标出来。 */
  editReply: (id: string, en: string) => void;
  version: number;

  init: () => Promise<void>;
  retrySession: () => Promise<void>;
  setOriginal: (text: string) => void;
  setSourceLang: (lang: SourceLanguage) => void;
  translate: (text: string, source: SourceKind, presetTranslation?: string, context?: string[]) => Promise<void>;
  transcribe: (blob: Blob, filename: string) => Promise<void>;
  askReply: (silent?: boolean) => Promise<void>;
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
        // 能走到这里说明「重建会话 + 重试一次」都没成，所以不再让用户刷新了事。
        return '服务端没能确认这次访问的匿名会话（已自动重建重试一次）。输入内容还在，点「重试」再发一次；仍然不行就是服务端在重启，稍等再试。';
      case 'TRANSLATE_FAILED':
        /*
         * 模型跑了，但输出退化成重复（`hello → 哈哈哈哈哈哈哈哈哈`）或原样吐回。
         * 这种结果宁可不给：听障使用者看到「哈哈哈哈哈」会以为对方真在笑。
         * 文案要给出可以马上做的事，而不是只说「失败」。
         */
        return '这句模型没翻出来（输出退化成重复）。换一种说法、把句子写完整，或者点「重试一次」。';
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
  sessionState: 'pending',
  sessionError: null,
  sourceLang: 'en',
  stage: 'idle',
  notice: null,
  original: '',
  translation: '',
  translateMode: null,
  translateNote: null,
  translateCorrected: false,
  translateMatched: null,
  translateVia: null,
  translateCorrections: [],
  transcribeMode: null,
  source: null,
  elapsedMs: null,
  requestId: null,
  facts: [],
  plan: null,
  numericCheck: null,
  replyText: '',
  replyMode: null,
  replies: [],
  replyCards: [],
  replyContext: [],
  version: 0,

  init: async () => {
    try {
      const health = await getHealth();
      set({ health, healthError: null });
    } catch (error) {
      // 健康检查失败不阻塞界面：文字输入与预置样例仍然可用。
      set({ healthError: describe(error) || '服务端不可达' });
    }
    await get().retrySession();
  },

  retrySession: async () => {
    set({ sessionState: 'pending', sessionError: null });
    try {
      await ensureSession(true);
      set({ sessionState: 'ready', sessionError: null });
    } catch (error) {
      set({ sessionState: 'failed', sessionError: describe(error) || '建立匿名会话失败' });
    }
  },

  setOriginal: (text) => set({ original: text }),

  /*
   * 切换源语言要清场。
   *
   * 日语原文配着英语读音、或者上一条中文译文留在屏幕上，都是「这条字幕是哪种
   * 语言」的谎。切语言等于换了一个任务，旧结果一律作废，让用户重新提交。
   */
  setSourceLang: (lang) => {
    if (get().sourceLang === lang) return;
    cancelInflight();
    set({
      version: get().version + 1,
      sourceLang: lang,
      stage: 'idle',
      original: '',
      translation: '',
      translateMode: null,
      translateNote: null,
      translateCorrected: false,
      translateMatched: null,
      translateVia: null,
      translateCorrections: [],
      transcribeMode: null,
      source: null,
      facts: [],
      plan: null,
      numericCheck: null,
      replyText: '',
      replyMode: null,
      replies: [],
      replyCards: [],
      replyContext: [],
      elapsedMs: null,
      requestId: null,
      notice: null,
    });
  },

  translate: async (text, source, presetTranslation, context = []) => {
    const next = get().version + 1;
    cancelInflight();
    set({
      version: next,
      stage: 'translating',
      notice: null,
      original: text,
      replyContext: context,
      translation: '',
      translateMode: null,
      translateNote: null,
      translateCorrected: false,
      translateMatched: null,
      translateVia: null,
      translateCorrections: [],
      source,
      elapsedMs: null,
      requestId: null,
      facts: [],
      plan: null,
      numericCheck: null,
      replyText: '',
      replyMode: null,
      replies: [],
      replyCards: [],
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
      const result = await withSession(
        () => apiTranslate(text, controller.signal, get().sourceLang),
        controller.signal,
      );
      if (get().version !== next) return;
      const facts = analyze(text, result.translation);
      set({
        stage: 'idle',
        translation: result.translation,
        translateMode: result.mode,
        translateNote: result.note ?? null,
        translateCorrected: Boolean(result.corrected),
        translateMatched: result.matched ?? null,
        translateVia: result.via ?? null,
        translateCorrections: result.corrections ?? [],
        elapsedMs: result.elapsed_ms,
        requestId: result.request_id,
        facts,
        numericCheck: checkNumericConsistency(text, result.translation),
        /*
         * 回复卡在**翻译成功的同一刻**就绪，不等网络。
         *
         * 这些句子是本地按事实拼的（不调模型），所以断网、没有 Key、
         * 额度用完都照样有；服务端真有模型时再覆盖成 AI 建议。
         */
        replyCards: planReplies(
          {
            original: text,
            translation: result.translation,
            facts: facts.map((fact) => ({ ...fact })),
            sourceLanguage: get().sourceLang,
            context: get().replyContext,
          },
          (part) => transliterate(part, 'English'),
        ),
      });
      // 第一次真的调通之后，把「尚未验证」的提示收掉（health 里 verified 变了）。
      if (get().health?.verified?.translate === false) {
        void getHealth()
          .then((health) => set({ health, healthError: null }))
          .catch(() => {});
      }
      /*
       * 翻译一出来，立刻自动生成一轮回复建议。
       *
       * 这就是「及时回复」：对方说完 → 字幕出来 → 同时就有三句能回的话，
       * 不用再点一次按钮。失败时静默（`silent`）：用户没要求过它，
       * 弹一条「回复次数用完了」只会让他在最需要信息的时候分心。
       */
      void get().askReply(true);
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
      translateNote: null,
      translateCorrected: false,
      translateMatched: null,
      translateVia: null,
      translateCorrections: [],
      transcribeMode: null,
      elapsedMs: null,
      requestId: null,
      replyText: '',
      replyMode: null,
      replies: [],
      replyCards: [],
    });
    const controller = new AbortController();
    inflight = controller;
    try {
      const heard = await withSession(() => apiTranscribe(blob, filename, controller.signal), controller.signal);
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

  /*
   * 回复建议。`silent=true` 时不写错误提示 —— 翻译完成后会自动调一次，
   * 那条路径上弹「回复次数用完了」只会打扰用户，他本来也没打算要回复建议。
   */
  askReply: async (silent = false) => {
    const { original, translation, version } = get();
    if (!original.trim()) return;
    const next = version + 1;
    cancelInflight();
    set({ version: next, stage: 'replying', notice: null });
    const controller = new AbortController();
    inflight = controller;
    try {
      const result = await withSession(
        () => apiReply(original, translation, controller.signal),
        controller.signal,
      );
      if (get().version !== next) return;
      /*
       * 服务端没有可用模型时（`mode === 'mock'`，也就是模板句），**不覆盖**
       * 本地那三张按事实拼出来的卡 —— 它们更贴合这句话（会说清币种、改期），
       * 而服务端模板是通用句。只有在真的调通了模型时才换成 AI 建议。
       */
      const modelCards: PlannedReply[] =
        result.mode !== 'mock' && result.suggestions?.length
          ? result.suggestions.map((suggestion, index) => ({
              id: `model-${index}`,
              kind: suggestion.kind === 'confirm' ? 'confirm' : suggestion.kind === 'ask' ? 'clarify' : 'polite',
              purpose: 'AI 建议（按当前对话生成）',
              en: suggestion.reply,
              zh: suggestion.meaning,
              segments: [
                {
                  en: suggestion.reply,
                  zh: suggestion.meaning,
                  phon: transliterate(suggestion.reply, 'English'),
                },
              ],
              why: '模型生成，可能包含原话没有的说法，请自己判断要不要说',
            }))
          : [];
      set({
        stage: 'idle',
        replyText: result.reply,
        replyMode: result.mode,
        replies: result.suggestions?.length
          ? result.suggestions
          : [{ reply: result.reply, meaning: result.meaning, kind: 'confirm' }],
        replyCards: modelCards.length ? modelCards : get().replyCards,
      });
    } catch (error) {
      if (get().version !== next) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      set(silent ? { stage: 'idle' } : { stage: 'idle', notice: { kind: 'error', text: describe(error) } });
    } finally {
      if (inflight === controller) inflight = null;
    }
  },

  /*
   * 用整段译文直接生成回复，不把几句话再翻一遍（那样既慢又会把事实抽乱）。
   * 原文是累积的全部句子，回复卡因此能按「所有内容」选场景，而不是只看最后一句。
   */
  usePassageForReply: (text, translation, context) => {
    const next = get().version + 1;
    cancelInflight();
    set({
      version: next,
      stage: 'idle',
      notice: { kind: 'info', text: '回复已按标签页整段内容生成（多句合并，未逐句核对）。' },
      original: text,
      translation,
      translateMode: null,
      translateNote: null,
      translateCorrected: false,
      translateMatched: null,
      translateVia: null,
      translateCorrections: [],
      source: 'text',
      elapsedMs: null,
      requestId: null,
      facts: [],
      plan: null,
      numericCheck: null,
      replyText: '',
      replyMode: null,
      replies: [],
      replyContext: context,
      replyCards: planReplies(
        { original: text, translation, facts: [], sourceLanguage: get().sourceLang, context },
        (part) => transliterate(part, 'English'),
      ),
    });
    // 服务端真配了模型时，仍让它有机会把这三张卡换成 AI 建议。
    void get().askReply(true);
  },

  editFact: (id, value) => {
    const facts = editRow(get().facts, id, value);
    set({ facts, plan: null });
  },

  speakFact: (id, value) => {
    set({ facts: setSpoken(get().facts, id, value), plan: null });
  },

  /*
   * 改英文句型时，近音要跟着重算，中文却**不能**跟着装懂。
   *
   * 用户在原来的句子上换个词（把 300 改成 500），中文意思大概率还成立；
   * 但整句重写之后，原来那句中文就变成了猜测。所以改过的卡一律标
   * 「中文是原句的意思，已不适用」，让他自己看一眼再念。
   */
  editReply: (id, en) => {
    const text = en.trim();
    set({
      replyCards: get().replyCards.map((card) =>
        card.id === id
          ? {
              ...card,
              en: text,
              zh: '（这行中文对应的是改之前的句子，改完请自己确认意思）',
              segments: [
                {
                  en: text,
                  zh: '',
                  phon: text ? transliterate(text, 'English') : '',
                },
              ],
              why: '你改过这一句：近音按新句子重算，中文不再保证对得上',
            }
          : card,
      ),
    });
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
      translateNote: null,
      translateCorrected: false,
      translateMatched: null,
      translateVia: null,
      translateCorrections: [],
      transcribeMode: null,
      source: null,
      facts: [],
      plan: null,
      numericCheck: null,
      replyText: '',
      replyMode: null,
      replies: [],
      replyCards: [],
      replyContext: [],
      elapsedMs: null,
      requestId: null,
      notice: null,
    });
  },

  dismissNotice: () => set({ notice: null }),
}));
