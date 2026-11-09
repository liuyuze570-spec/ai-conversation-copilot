import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useConversationStore } from '../stores/conversation';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { useLatencyStore } from '../stores/latency';
import { useFactsStore } from '../stores/facts';
import type { ReplyDraft } from '../../services/types';
import type {
  ConversationItem,
  ListeningStatus,
  ReplySuggestion,
  ScenarioMode,
} from '../../shared/types';
import { extractFactsWithRules, factsForConfirm, type FactItem } from '../../shared/facts';
import { LANGUAGE_TAGS } from '../../shared/types';
import { levelFor } from '../../shared/levels';
import { canWatchForPause } from '../../shared/audio-status';
import {
  acceptsTranscript,
  captureAction,
  closeCaptureGate,
  gateAfterSessionReset,
  initialCaptureGate,
  isCaptureActive,
  openCaptureGate,
  type CaptureGate,
} from '../../shared/capture-state';
import { registerSessionReset } from '../lib/session-reset';
import { HINT_VERSION, buildHintPlan } from '../../services/pronunciation';
import { bcp47For, type HintSystem } from '../../shared/languages';
import { describeAiError } from '../../shared/ai-errors';
import { WebSpeechTTS } from '../../services/tts/web-speech';
import { OpenAITTS } from '../../services/tts/openai-tts';
import type { TTSProvider } from '../../services/types';

export type CopilotMode =
  | 'reply'
  | 'simple'
  | 'natural'
  | 'continue'
  | 'rephrase'
  | 'simplify'
  | 'didnt-catch'
  | 'from-chinese';

/** How long a partial line must stay unchanged before we translate it live. */
const LIVE_TRANSLATE_DEBOUNCE_MS = 700;

/**
 * 0.6.3：界面这一侧的回复超时。
 * 主进程 LLM 单次 45s、失败还会重试，最坏能等两分钟以上；用户实测
 * 「输入中文后等了两分钟没反应，输入框却已经清空」。这里给一个可感知的
 * 上限，超时就 abort 主进程请求、保留草稿、明确报错并可一键重试。
 */
const REPLY_TIMEOUT_MS = 45_000;

/**
 * 一轮监听里最多为「事实卡」问模型多少次。
 *
 * 事实提取是额外请求 —— 不能让它无限加钱。40 次大约覆盖一场 20 分钟的
 * 会议里真正有约定内容的句子；超过之后仍然有本地正则的结果可用。
 */
const MAX_MODEL_FACT_CALLS = 40;

let suggestionCounter = 0;
function toSuggestion(draft: ReplyDraft, hintSystem: HintSystem): ReplySuggestion {
  suggestionCounter += 1;
  return {
    id: `s${suggestionCounter}`,
    kind: draft.kind ?? 'natural',
    english: draft.english,
    chinese: draft.chinese ?? '',
    // 通用字段优先：释义语言、提示字系都可能不是中文/汉字。
    meaning: draft.meaning ?? draft.chinese ?? '',
    ipa: draft.ipa,
    syllables: draft.syllables,
    chinesePronunciation: draft.chinesePronunciation,
    readingHint: draft.readingHint,
    hintSystem,
    // 本地引擎算过就用它的结论（含 approx = 规则近似）；没算过才退回旧推断。
    hintStatus:
      draft.hintStatus ??
      (draft.readingHint || draft.chinesePronunciation
        ? 'ok'
        : hintSystem === 'none'
          ? 'none'
          : 'partial'),
    hintVersion: draft.readingHint ? HINT_VERSION : undefined,
    romanization: draft.romanization,
  };
}

export function useCopilot() {
  const settings = useSettingsStore((state) => state.settings);
  const loadSettings = useSettingsStore((state) => state.load);
  const upsert = useConversationStore((state) => state.upsert);
  const contextText = useConversationStore((state) => state.contextText);
  const clearConversationStore = useConversationStore((state) => state.clear);

  const setStatus = useUiStore((state) => state.setStatus);
  const setSuggestions = useUiStore((state) => state.setSuggestions);
  const setBusy = useUiStore((state) => state.setBusy);
  const setError = useUiStore((state) => state.setError);
  const setSpeakingId = useUiStore((state) => state.setSpeakingId);
  const setLastMode = useUiStore((state) => state.setLastMode);
  const setShowPrivacy = useUiStore((state) => state.setShowPrivacy);
  const setLevel = useUiStore((state) => state.setLevel);
  const setLatency = useLatencyStore((state) => state.setSnapshot);
  const refreshLatency = useLatencyStore((state) => state.refresh);

  const ttsRef = useRef<TTSProvider | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /**
   * 字幕项 id → 这一轮的时延埋点 id。
   *
   * 识别在主进程、翻译也走主进程，中间隔着渲染层一个来回。把埋点 id 原样带
   * 回去，主进程才能把「识别」和「翻译」两段耗时拼成一轮真正的端到端数字 ——
   * 而这正是「下一步该优化哪里」唯一的依据。
   */
  const traceByItemRef = useRef(new Map<string, string>());

  /**
   * 回复请求的编号。
   *
   * 用户按 Alt+Space 很快按了两次、或者在自动回复还没回来时又点了一次，
   * 就会有**两个请求同时在飞**。谁先回来是不确定的 —— 旧实现不看编号，
   * 于是「后发的那次」可能先回来，紧接着「先发的旧答案」把它覆盖掉：
   * 用户看到的三张卡答的是**上一轮**的话。
   *
   * 规则：每次发起请求 +1，回来时对不上就整包丢弃（成功和失败都丢）。
   */
  const replySeqRef = useRef(0);
  /** 最近一次回复请求在主进程里的编号（用于「发起替代请求时掐掉旧的」）。 */
  const lastReplyReqRef = useRef('');
  /** 还没回来的回复请求数。busy 用计数，不是布尔 —— 否则先完成那个会提前关掉忙碌态。 */
  const repliesPendingRef = useRef(0);
  /** 朗读的代次号：防止「上一句的 finally」把这一句的播放状态清掉。 */
  const speakSeqRef = useRef(0);
  /**
   * 已经接收过的最新音频会话编号。
   *
   * 停止 → 重新开始监听后，编号会 +1；比它旧的识别结果一律丢弃，
   * 那是上一场对话的内容。
   */
  const lastSessionRef = useRef(0);
  /**
   * 0.6.3 会话闸门：停止时**同步**关闸，不等 audioStop 的 await 回来。
   * 主进程已经按 sessionId / engineGeneration 挡过一次，但「停止瞬间已经
   * 排在 IPC 队列里」「超时才回来的识别」「切换会话后旧回包」这三类会穿过
   * 那层过滤；渲染层再挡一道，保证新会话里不会出现上一场字幕。
   */
  const captureGateRef = useRef<CaptureGate>(initialCaptureGate());

  /** Pending debounce for translating the line that is still being spoken. */
  const partialTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Silence watchdog: fires when the other side stops talking (= video paused). */
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Always points at the latest pauseAndReply, so the timer never goes stale. */
  const pauseAndReplyRef = useRef<() => Promise<void>>(async () => {});
  /**
   * 每条字幕的翻译请求序号。
   *
   * 「中途译文」和「整句译文」写的是同一张卡片（定稿时会复用 partial 的气泡），
   * 两个请求并发发出时，先发的那个可能后回来 —— 于是正确的整句译文被半句的
   * 旧译文盖掉，用户看到的中文和英文就对不上了。这里只认最新一次请求的结果。
   */
  const translateSeqRef = useRef(new Map<string, number>());
  /**
   * 每条字幕当前那次翻译在主进程里的请求编号。
   *
   * 有了它「停止 / 取消」才是真的停止：以前只是回来时丢弃结果，底层 HTTP 还在
   * 跑，钱照花，而且迟到的那次会把状态从 `cancelled` 改回 `ok` —— 界面明明
   * 写着「已停止翻译」，几秒后自己变成了译文。
   */
  const translateReqRef = useRef(new Map<string, string>());
  /**
   * 指向最新的 `scheduleFacts`。
   *
   * `translateNow` 在它之前定义（翻译成功时要顺手补一遍事实提取），直接引用
   * 会造成 useCallback 的循环依赖，所以用 ref 中转一下。
   */
  const scheduleFactsRef = useRef<(item: ConversationItem) => void>(() => {});

  /** 把一个字幕 id 的在途翻译掐掉（主进程 abort + 本地序号作废）。 */
  const cancelTranslation = useCallback((id: string) => {
    const requestId = translateReqRef.current.get(id);
    translateReqRef.current.delete(id);
    if (requestId) void window.copilot.aiCancel(requestId);
    // 序号推进一格：即使那次请求已经在回来的路上，也会被当成过期结果丢掉。
    translateSeqRef.current.set(id, (translateSeqRef.current.get(id) ?? 0) + 1);
  }, []);

  const getTts = useCallback((): TTSProvider => {
    const current = settingsRef.current;
    const wanted = current.ai.ttsProvider === 'openai' ? 'openai-tts' : 'web-speech';
    if (!ttsRef.current || ttsRef.current.id !== wanted) {
      ttsRef.current =
        wanted === 'openai-tts'
          ? new OpenAITTS(
              (text, speed, requestId) => window.copilot.aiTts(text, speed, requestId),
              (requestId) => void window.copilot.aiCancel(requestId),
            )
          : new WebSpeechTTS();
    }
    return ttsRef.current;
  }, []);

  // ---- boot -------------------------------------------------------------
  useEffect(() => {
    void loadSettings().then(() => {
      const loaded = useSettingsStore.getState().settings;
      if (!loaded.privacyAccepted) setShowPrivacy(true);
    });
    // 上一场监听留下的样本还在主进程内存里 —— 打开就把「性能」页的数据补齐。
    void refreshLatency();
  }, [loadSettings, setShowPrivacy, refreshLatency]);

  // ---- helpers -----------------------------------------------------------
  const contextLines = useCallback(
    () =>
      useConversationStore
        .getState()
        .recentItems(6)
        // 把上一句的译文一并带上：模型能保持人称、译名一致，字幕读起来不会跳。
        .map((item) => {
          const label = item.speaker === 'foreign' ? 'Foreign' : 'You';
          const translated = item.translatedText ? ` = ${item.translatedText}` : '';
          return `${label}: ${item.originalText}${translated}`;
        }),
    [],
  );

  const translateNow = useCallback(
    (id: string, text: string, isFinal = false) => {
      const seq = (translateSeqRef.current.get(id) ?? 0) + 1;
      translateSeqRef.current.set(id, seq);
      /*
       * 先把状态摆成「翻译中」。没有这一步，失败时界面和等待时长得一模一样，
       * 用户永远不知道该等还是该重试（审计原话：字幕要区分等待/成功/失败/取消）。
       */
      useConversationStore.getState().setTranslationState(id, 'pending');

      const requestId = `tr:${id}:${seq}`;
      translateReqRef.current.set(id, requestId);

      window.copilot
        .aiTranslate(text, contextLines(), traceByItemRef.current.get(id), requestId)
        .then((result) => {
          // 晚到的旧请求直接丢掉，别覆盖已经定稿的整句译文。
          if (translateSeqRef.current.get(id) !== seq) return;
          // 用户已停止 / 已取消：这次结果不能把「已停止翻译」改回成功。
          const item = useConversationStore.getState().items.find((entry) => entry.id === id);
          if (item?.translationState === 'cancelled') return;
          /*
           * 主进程现在回的是结构化结果，不再是一个空字符串。
           * 取消 → 什么都不做（状态已由取消逻辑定好，不该报红）；
           * 失败 → 记下分类与「下一步怎么办」，界面才有可执行的信息。
           */
          if (!result.ok) {
            if (result.cancelled) return;
            useConversationStore.getState().setTranslationError(
              id,
              result.error ?? {
                code: 'unknown',
                title: '这句没翻译出来',
                hint: '点这一句的「重试」；如果一直失败，去设置 → API 功能点「测试连接」。',
              },
            );
            return;
          }
          useConversationStore.getState().setTranslation(id, result.text);
          /*
           * 译文到了，再补一遍规则提取：中文里常见「明天下午三点」这种表达，
           * 只在译文里出现。`addMany` 按「类型 + 内容 + 字幕」去重，
           * 重复跑不会产生重复卡片。
           */
          if (isFinal) {
            const updated = useConversationStore
              .getState()
              .items.find((entry) => entry.id === id);
            if (updated) scheduleFactsRef.current(updated);
          }
          if (isFinal) {
            translateSeqRef.current.delete(id);
            translateReqRef.current.delete(id);
          }
        })
        .catch(() => {
          if (translateSeqRef.current.get(id) !== seq) return;
          const item = useConversationStore.getState().items.find((entry) => entry.id === id);
          // 取消导致的 reject 不是失败：状态已经由 cancelPendingTranslations 定好。
          if (item?.translationState === 'cancelled') return;
          useConversationStore.getState().setTranslationError(id, {
            code: 'ipc',
            title: '翻译请求没能送出去',
            hint: '点这一句的「重试」。如果反复出现，重新打开软件再试。',
          });
          // 日志只记错误名，不记内容（错误里可能带着句子）。
          window.copilot.log('ERROR', 'Renderer', 'translate ipc failed');
        });
    },
    [contextLines],
  );

  /**
   * 逐句重试译文。失败和「已停止翻译」的字幕都靠它救回来 ——
   * 用户不用因为一句话没翻出来就重开整场对话。
   */
  const retryTranslate = useCallback(
    (id: string) => {
      const item = useConversationStore.getState().items.find((entry) => entry.id === id);
      if (!item) return;
      // 先把上一次（可能还挂着的）请求掐掉，再重发，避免两个请求抢同一行。
      cancelTranslation(id);
      translateNow(id, item.originalText, true);
    },
    [cancelTranslation, translateNow],
  );

  /** 半句话不值得翻：太短的中途文本翻出来只会让人以为"翻译错了"。 */
  const PARTIAL_MIN_WORDS = 3;

  /** Live subtitles: translate the half-finished line, but only once it settles. */
  const schedulePartialTranslation = useCallback(
    (id: string, text: string) => {
      if (partialTimerRef.current) clearTimeout(partialTimerRef.current);
      if (text.trim().split(/\s+/).filter(Boolean).length < PARTIAL_MIN_WORDS) return;
      partialTimerRef.current = setTimeout(() => {
        partialTimerRef.current = null;
        translateNow(id, text);
      }, LIVE_TRANSLATE_DEBOUNCE_MS);
    },
    [translateNow],
  );

  const cancelPartialTranslation = useCallback(() => {
    if (partialTimerRef.current) {
      clearTimeout(partialTimerRef.current);
      partialTimerRef.current = null;
    }
  }, []);

  // ---- 关键事实确认卡 ----------------------------------------------------
  /** 已经处理过的字幕 id（同一条字幕不重复提取）。 */
  const factDoneRef = useRef(new Set<string>());
  /** 每条字幕当前那次「模型提取」的请求编号（取消 / 去重用）。 */
  const factReqRef = useRef(new Map<string, string>());
  /** 本轮监听已经问了模型几次 —— 给成本封顶，避免长会议一直加钱。 */
  const factModelCallsRef = useRef(0);
  /**
   * 同一句话重复出现时复用模型结果（键 = 原文归一化）。
   *
   * 讲座、会议里同一句话被重复说很常见（"明天下午三点"、"再说一次"），
   * 每次都问模型纯属白花钱。命中缓存就本地重新盖一遍 itemId 直接入库 ——
   * 事实仍然挂在**这一句**上（点它能定位到这一句），只是不再联网。
   */
  const factCacheRef = useRef(new Map<string, FactItem[]>());

  /** 只对「像是有约定/有数字」的句子问模型，其余交给本地正则。 */
  const COMMITMENT_HINT =
    /(will|going to|need to|have to|must|should|remember|bring|meet|meeting|deadline|send|pay|book|call|schedule|appointment|tomorrow|today|tonight|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|надо|нужно|встреч|завтра|срок|понедельник|明日|明後日|会議|資料|締め切り|来週|내일|회의|준비|약속|다음 주)/i;

  /** 本地规则：立刻出结果、零成本、不联网。 */
  const runFactRules = useCallback((item: ConversationItem) => {
    const store = useFactsStore.getState();
    const drafts = extractFactsWithRules({
      originalText: item.originalText,
      translatedText: item.translatedText,
    });
    if (!drafts.length) {
      // 这一句没有事实时也要清掉上一次（原文阶段）留下的规则结果：
      // 比如原文「3 pm」被认成时间，译文回来后合并成「下午三点」，旧的那条
      // 必须让位，否则界面上同一件事会出现两行。
      if (item.translatedText) store.replaceRuleFacts(item.id, []);
      return 0;
    }
    const roundIndex = useConversationStore.getState().roundIndex;
    const built = drafts.map((draft, index) => ({
      id: `fr-${item.id}-${index}`,
      kind: draft.kind,
      value: draft.value,
      sourceText: draft.sourceText,
      sourceField: draft.sourceField,
      itemId: item.id,
      roundIndex,
      certainty: draft.certainty,
      negated: draft.negated,
      status: 'pending' as const,
      createdAt: Date.now(),
    }));
    // 译文回来后的那次提取是「更完整的一版」，用它替换上一版，而不是追加。
    if (item.translatedText) store.replaceRuleFacts(item.id, built);
    else store.addMany(built);
    return drafts.length;
  }, []);

  /**
   * 问模型补「规则做不了」的部分（人名、组织、待办、负责人）。
   *
   * 三条克制：只在像有约定的句子上问、每条字幕只问一次、本轮最多问
   * MAX_MODEL_FACT_CALLS 次。提取失败一律静默 —— 它不能影响字幕和翻译。
   */
  const requestModelFacts = useCallback((item: ConversationItem) => {
    const requestId = `fx:${item.id}`;
    const roundIndex = useConversationStore.getState().roundIndex;
    /**
     * 缓存命中：不再联网，但事实必须挂到**这一句**上 —— 点它要能定位到
     * 当前这条字幕，而不是当初那句。
     */
    const cacheKey = item.originalText.trim().toLowerCase().replace(/\s+/g, ' ');
    const cached = factCacheRef.current.get(cacheKey);
    if (cached?.length) {
      useFactsStore.getState().addMany(
        cached.map((fact, index) => ({
          ...fact,
          id: `fm-${item.id}-${index}`,
          itemId: item.id,
          roundIndex,
          createdAt: Date.now(),
        })),
      );
      return;
    }
    factReqRef.current.set(item.id, requestId);
    factModelCallsRef.current += 1;
    void window.copilot
      .factsExtract({
        itemId: item.id,
        originalText: item.originalText,
        translatedText: item.translatedText,
        language: settingsRef.current.targetLanguage,
        roundIndex,
        requestId,
      })
      .then((result) => {
        // 这期间用户可能已经停止监听 / 清空了对话 —— 结果一律丢掉。
        if (factReqRef.current.get(item.id) !== requestId) return;
        if (!result.ok) return;
        useFactsStore.getState().addMany(result.facts);
        if (result.facts.length) {
          // 只留最近 200 句，避免长会话把内存吃满。
          factCacheRef.current.set(cacheKey, result.facts);
          if (factCacheRef.current.size > 200) {
            const oldest = factCacheRef.current.keys().next().value;
            if (oldest !== undefined) factCacheRef.current.delete(oldest);
          }
        }
      })
      .catch(() => {
        /* 提取是锦上添花，失败不提示、不打扰 */
      })
      .finally(() => {
        if (factReqRef.current.get(item.id) === requestId) {
          factReqRef.current.delete(item.id);
        }
      });
  }, []);

  /** 一条字幕定稿后调用一次（译文回来时会再调一次，补上中文里的时间）。 */
  const scheduleFacts = useCallback(
    (item: ConversationItem) => {
      const config = settingsRef.current;
      if (!config.facts.enabled) return;
      const ruleCount = runFactRules(item);
      if (!config.facts.useModel) return;
      if (factDoneRef.current.has(item.id)) return;
      // 已经问过模型的不再问；本地规则先跑，是为了判断「这句话有没有料」。
      const worthAsking = ruleCount > 0 || COMMITMENT_HINT.test(item.originalText);
      if (!worthAsking) return;
      if (factModelCallsRef.current >= MAX_MODEL_FACT_CALLS) return;
      factDoneRef.current.add(item.id);
      if (factDoneRef.current.size > 400) {
        // 只保留最近的一批 id，避免长会话里这个集合一直长。
        const keep = [...factDoneRef.current].slice(-200);
        factDoneRef.current = new Set(keep);
      }
      requestModelFacts(item);
    },
    [runFactRules, requestModelFacts],
  );

  /** 把还没回来的提取请求全部取消（停止监听 / 清空对话时）。 */
  const cancelFactRequests = useCallback(() => {    for (const requestId of factReqRef.current.values()) {
      void window.copilot.aiCancel(requestId);
    }
    factReqRef.current.clear();
    factDoneRef.current.clear();
    factModelCallsRef.current = 0;
    factCacheRef.current.clear();
  }, []);

  // 让 translateNow 能拿到最新的 scheduleFacts（见上面的 ref 注释）。
  scheduleFactsRef.current = scheduleFacts;


  /**
   * 清空当前对话（切会话 / 点「清空」）。
   *
   * 除了字幕，还必须一起清掉：事实卡、在途的提取请求、在途的翻译/回复/朗读。
   * 只清字幕的话，几秒后旧会话的译文和事实会挂到新会话的界面上 —— 那是最
   * 容易让人以为「它记错了」的一类错。
   */
  const clearConversation = useCallback(() => {
    /*
     * 0.6.3：切会话也要抬闸门。只清字幕不够 —— 上一场已经排进 IPC 队列的
     * 字幕、超时才回来的识别，会在清场之后又写进新会话。
     */
    captureGateRef.current = gateAfterSessionReset(
      captureGateRef.current,
      lastSessionRef.current,
    );
    const pendingTranslate = [...translateReqRef.current.entries()];
    translateReqRef.current.clear();
    for (const [id, requestId] of pendingTranslate) {
      translateSeqRef.current.set(id, (translateSeqRef.current.get(id) ?? 0) + 1);
      void window.copilot.aiCancel(requestId);
    }
    if (lastReplyReqRef.current) {
      void window.copilot.aiCancel(lastReplyReqRef.current);
      lastReplyReqRef.current = '';
    }
    cancelFactRequests();
    replySeqRef.current += 1;
    repliesPendingRef.current = 0;
    setBusy(false);
    if (useUiStore.getState().compose.phase === 'pending') {
      useUiStore.getState().setCompose({
        phase: 'error',
        error: '已切换会话，这次生成被取消。草稿已保留，可点「重试」。',
      });
    }
    useFactsStore.getState().clear();
    clearConversationStore();
    useUiStore.getState().setSuggestions([]);
  }, [cancelFactRequests, clearConversationStore, setBusy]);
  /*
   * 把「清场」注册成模块级单例。
   *
   * useSessions() 在 App 和 RecordsPanel 里各被调用一次，实例之间互不相通；
   * 只有这里（useCopilot）持有所有在途请求的引用，所以由这里注册，
   * 各处的会话切换都调 resetLiveSession() 走同一条路。
   */
  useEffect(() => registerSessionReset(clearConversation), [clearConversation]);

  /**
   * (Re)start the silence watchdog. Only armed in video / exam mode, and only
   * after the other side has actually said something — otherwise opening the
   * app would "pause" an empty conversation.
   */
  const armPauseTimer = useCallback(() => {
    if (pauseTimerRef.current) {
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
    const config = settingsRef.current;
    if (config.scenarioMode === 'conversation') return;
    if (!config.autoReplyOnPause) return;
    // 只要还在采集就算「在监听」（'no-audio' 只是「这一会儿没听到声音」）。
    // 这条判断曾经是「第二轮之后再也不会自动回应」的直接原因，规则与理由
    // 都写在 shared/audio-status.ts 里，别在这里重新发明。
    if (!canWatchForPause(useUiStore.getState().status)) return;

    pauseTimerRef.current = setTimeout(() => {
      pauseTimerRef.current = null;
      const ui = useUiStore.getState();
      if (!canWatchForPause(ui.status)) return;
      // Never yank the user out of a panel they deliberately opened.
      if (ui.showSettings || ui.showRecords || ui.showPrivacy) return;
      if (ui.busy) return;
      window.copilot.log('INFO', 'Renderer', 'silence detected → pause & generate reply');
      void pauseAndReplyRef.current();
    }, config.pauseDetectMs);
  }, []);

  // ---- transcript pipeline ---------------------------------------------
  useEffect(() => {
    const offTranscript = window.copilot.onTranscript((payload) => {
      /*
       * 0.6.3：闸门关着（用户已点停止 / 切过会话）就一律不写。
       * 必须放在 sessionId 更新**之前**：旧回包如果先把 lastSessionRef
       * 顶上去，下一次新会话的合法字幕反而会被误判成过时。
       */
      if (!acceptsTranscript(captureGateRef.current, payload.sessionId)) {
        window.copilot.log('INFO', 'Renderer', 'drop transcript: capture gate closed');
        return;
      }
      /*
       * 会话编号：只在「同一个场次」里认字幕。
       *
       * 主进程已经按编号过滤过一次，这里再挡一道 —— 两边都挡过，才不怕
       * 「停止瞬间正好有一条在 IPC 队列里」这种时序。
       */
      if (typeof payload.sessionId === 'number') {
        if (payload.sessionId < lastSessionRef.current) {
          window.copilot.log(
            'INFO',
            'Renderer',
            `drop stale transcript (session ${payload.sessionId} < ${lastSessionRef.current})`,
          );
          return;
        }
        lastSessionRef.current = payload.sessionId;
      }

      const finalized = upsert(payload);
      /*
       * 谐音在这里算一次，然后**存进字幕项**。
       *
       * 两个理由：
       *  1. 历史记录要能原样还原「当时看到的那行字」，不能因为本地引擎后来
       *     改了规则就变样；
       *  2. 恢复旧记录时不允许再调用任何模型 —— 存在库里就是最省事的保证。
       * 它走的是本地规则引擎（不联网、不花额度），所以定稿时算一次没有代价。
       */
      if (finalized && finalized.speaker === 'foreign') {
        /*
         * 提示按**当前方向**算：理解语言 + 目标语言 + 提示体系。
         *
         * 换了理解语言之后，旧字幕不该被重新标成新字系的音 —— 已定稿的项
         * 只在定稿那一刻算一次并存下来，历史记录里显示的就是当时那行字。
         */
        const settings = settingsRef.current;
        const plan = buildHintPlan(
          finalized.originalText,
          settings.targetLanguage,
          settings.hintSystem ?? 'hanzi',
          settings.pronunciation?.customReadings,
        );
        if (plan.text) {
          useConversationStore
            .getState()
            .setRomanization(
              finalized.id,
              plan.text,
              settings.hintSystem ?? 'hanzi',
              plan.version,
            );
        }
      }
      // 记下这一轮的埋点 id。中途结果和整句写的是同一张卡，谁都可能先到，
      // 所以两个分支都要记（中途时 upsert 返回 null）。
      if (payload.traceId) {
        const itemId = finalized?.id ?? useConversationStore.getState().partialItem()?.id;
        if (itemId) {
          const traces = traceByItemRef.current;
          traces.set(itemId, payload.traceId);
          // 字幕卡会被不断替换，不清理这张表会一直长大。
          if (traces.size > 80) {
            const oldest = traces.keys().next().value;
            if (oldest) traces.delete(oldest);
          }
        }
      }
      const current = settingsRef.current;

      const ui = useUiStore.getState();
      // 收到新的语音 = 采集链路是活的。状态如果还停在「没听到声音」，先捞回来，
      // 否则下面 armPauseTimer 会因为门槛不满足而直接放弃整场对话的自动回复。
      if (ui.status === 'no-audio') ui.setStatus('listening');
      // Any incoming speech means the other side is talking again.
      if (ui.playback !== 'playing') {
        ui.setPlayback('playing');
      }
      armPauseTimer();

      /*
       * 事实提取只认**定稿**字幕，而且放在 `showTranslation` 判断之前 ——
       * 用户关掉译文显示时，事实卡仍然该工作（两件事互不相干）。
       */
      if (finalized) scheduleFacts(finalized);

      if (!current.subtitle.showTranslation) return;

      if (!finalized) {
        // Partial line: keep the live subtitle bar moving in video/exam mode.
        if (current.scenarioMode === 'conversation') return;
        const partial = useConversationStore.getState().partialItem();
        if (!partial) return;
        schedulePartialTranslation(partial.id, partial.originalText);
        return;
      }

      if (finalized.speaker !== 'foreign') return;
      cancelPartialTranslation();
      translateNow(finalized.id, finalized.originalText, true);
    });

    const offStatus = window.copilot.onAudioStatus((payload) => {
      /*
       * 0.6.3：停止之后迟到的「正在采集」回包不许把状态改回去。
       * 主进程 stopAudioPipeline 会推进 engineGeneration 并丢弃在途上报，
       * 但 IPC 队列里已经排好的那条仍会到渲染层；这里按闸门再挡一道。
       */
      if (
        !captureGateRef.current.active &&
        isCaptureActive(payload.status as ListeningStatus)
      ) {
        window.copilot.log('INFO', 'Renderer', 'drop stale audio status after stop');
        return;
      }
      setStatus(payload.status as never, payload.message ?? '');
    });

    // Proof of life: the loudness of what the sidecar is actually hearing.
    const offLevel = window.copilot.onAudioLevel((payload) => setLevel(payload));

    /*
     * 丢了一段音频 → 在字幕流里留一个可见的标记。
     *
     * 「有一段没转写」是用户必须知道的事实：他可能正好漏掉了时间或金额。
     * 只在日志里写一行，等于让界面看起来「完整」。
     */
    const offDropped = window.copilot.onAudioDropped((payload) => {
      useConversationStore.getState().addMark({ at: payload.at, reason: payload.reason });
    });

    // 时延样本由主进程采集，这里只负责收下来给「性能」页看。
    const offLatency = window.copilot.onLatency((snapshot) => setLatency(snapshot));

    return () => {
      offTranscript();
      offStatus();
      offLevel();
      offDropped();
      offLatency();
    };
  }, [
    upsert,
    setStatus,
    armPauseTimer,
    schedulePartialTranslation,
    cancelPartialTranslation,
    translateNow,
    setLevel,
    setLatency,
  ]);

  // Cancel every pending timer when the hook goes away.
  useEffect(
    () => () => {
      cancelPartialTranslation();
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
    },
    [cancelPartialTranslation],
  );

  // ---- listening control -------------------------------------------------
  /**
   * 启动请求的代次。
   *
   * 主进程现在也会校验代次；界面这一层同样要校验，因为「点开始 → 还在等设备
   * 确认 → 用户点暂停」这条路径上，回执会在暂停之后才到。没有代次的话，
   * 那个迟到的 `ok` 会把状态又写回「正在采集」，而音频其实已经停了。
   */
  const audioEpochRef = useRef(0);

  const startListening = useCallback(async () => {
    const epoch = (audioEpochRef.current += 1);
    // 0.6.3：开闸放在最前面（同步）。启动请求发出去后随时可能来字幕，
    // 等 await 回来再开闸会丢掉开场的那一两句。
    captureGateRef.current = openCaptureGate(captureGateRef.current);
    setError(null);
    setLevel(null);
    /*
     * 先写「正在连接」，再等真实回执。
     *
     * 主进程现在会等 sidecar 确认设备才回 ok —— 这中间可能有一两秒，
     * 不给反馈的话用户会以为点了没反应，于是连着点好几次。
     */
    setStatus('starting', '正在连接音频设备…');
    const result = await window.copilot.audioStart();
    if (epoch !== audioEpochRef.current) return;
    // 被「暂停 / 重连 / 再点一次开始」取代了：既不报成功，也不报错。
    if (result.ok || result.kind === 'cancelled') return;
    if (result.kind === 'pending') {
      // 进程起来了但设备还没确认：不算失败，也绝对不能写成「正在采集」。
      setStatus('starting', result.message ?? '正在连接音频设备…');
      return;
    }
    setStatus('error', result.message ?? '无法启动音频监听');
    setError(result.message ?? '无法启动音频监听');
  }, [setError, setStatus, setLevel]);

  /**
   * 「重新连接音频」。
   *
   * 音频进程死掉（设备被拔、被独占、被杀毒软件结束）之后，用户不该被迫
   * 重启整个软件 —— 一场会议中间重启等于错过了整段对话。
   */
  const reconnectAudio = useCallback(async () => {
    const epoch = (audioEpochRef.current += 1);
    setError(null);
    setLevel(null);
    setStatus('starting', '正在重新连接音频设备…');
    const result = await window.copilot.audioReconnect();
    if (epoch !== audioEpochRef.current) return;
    // 被「暂停 / 重连 / 再点一次开始」取代了：既不报成功，也不报错。
    if (result.ok || result.kind === 'cancelled') return;
    if (result.kind === 'pending') {
      setStatus('starting', result.message ?? '正在重新连接音频设备…');
      return;
    }
    setStatus('error', result.message ?? '重新连接失败');
    setError(result.message ?? '重新连接失败');
  }, [setError, setStatus, setLevel]);

  /**
   * 一键「听电脑的声音」。
   *
   * 0.4.0 的实现有三个毛病，这一版一起修：
   * 1. 它把自己的状态覆盖成 `starting` 而**不看**启动回执 —— 成功之后也写
   *    「正在连接」，于是界面永远连不上；
   * 2. 它只打开 `captureSystemAudio`，却没有明确「音源用途」。如果用户上次
   *    停在「现场沟通」，麦克风仍然是主角，系统声音反而被让位，点完还是听不到；
   * 3. 失败时什么都不说。
   *
   * 现在：先明确用途为线上交流 → 等回执 → 按回执的三种结果分别处理。
   */
  const listenToSystemAudio = useCallback(async () => {
    const epoch = (audioEpochRef.current += 1);
    setError(null);
    setLevel(null);
    setStatus('starting', '正在切换到电脑声音…');
    const store = useSettingsStore.getState();
    await store.update({
      mockMode: false,
      audio: {
        ...store.settings.audio,
        captureSystemAudio: true,
        sourceMode: 'online',
      },
    });
    const result = await window.copilot.audioStart();
    if (epoch !== audioEpochRef.current) return;
    // 被「暂停 / 重连 / 再点一次开始」取代了：既不报成功，也不报错。
    if (result.ok || result.kind === 'cancelled') return;
    if (result.kind === 'pending') {
      setStatus('starting', result.message ?? '正在连接音频设备…');
      return;
    }
    setStatus('error', result.message ?? '无法启动音频监听');
    setError(result.message ?? '无法启动音频监听');
  }, [setError, setLevel, setStatus]);

  const stopListening = useCallback(async () => {
    /*
     * 0.6.3：关闸必须在**任何 await 之前**同步完成。
     * 先关闸再 audioStop，则「停止瞬间已排在 IPC 队列」「设备关闭过程中
     * 才回来的识别」「超时回包」全部会被 onTranscript 拒掉，不会写进
     * 当前（或下一次新建的）会话。重复点停止也只会多推进一次代次，
     * 不会重新开闸。
     */
    captureGateRef.current = closeCaptureGate(
      captureGateRef.current,
      lastSessionRef.current,
    );
    // 代次 +1：任何还在等回执的启动请求就此作废，迟到的结果不许再改状态。
    audioEpochRef.current += 1;
    await window.copilot.audioStop();
    if (pauseTimerRef.current) {
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
    // 已经不在听了，在途的回复请求也就没有意义了 —— 作废它们，
    // 免得几秒后「上一场对话的回复」突然弹出来。
    replySeqRef.current += 1;
    repliesPendingRef.current = 0;
    setBusy(false);
    /*
     * 停止会作废在途的回复请求，那条请求再也不会走到 success/error 分支。
     * 如果它正是「中文 → 外语」，界面会永远停在「处理中」—— 这里补终态，
     * 草稿仍然保留，用户可以直接点重试。
     */
    if (useUiStore.getState().compose.phase === 'pending') {
      useUiStore.getState().setCompose({
        phase: 'error',
        error: '已停止采集，这次生成被取消。草稿已保留，可点「重试」。',
      });
    }
    /*
     * 把还在飞的翻译、回复、朗读全部取消掉。
     *
     * 顺序很关键：先取消（推进本地序号 + 让主进程 abort），再改字幕状态。
     * 反过来的话，那次请求可能正好在两步之间回来，把状态从 cancelled 改回 ok。
     */
    const pendingTranslate = [...translateReqRef.current.entries()];
    translateReqRef.current.clear();
    for (const [id, requestId] of pendingTranslate) {
      translateSeqRef.current.set(id, (translateSeqRef.current.get(id) ?? 0) + 1);
      void window.copilot.aiCancel(requestId);
    }
    if (lastReplyReqRef.current) {
      void window.copilot.aiCancel(lastReplyReqRef.current);
      lastReplyReqRef.current = '';
    }
    // 停止监听时，事实提取也没必要再跑了（额度花在已经不看的字幕上没有意义）。
    cancelFactRequests();
    speakSeqRef.current += 1;
    try {
      getTts().stop();
    } catch {
      /* 系统朗读在某些机器上没有实现 */
    }
    // 已经作废的翻译请求不会再回来，界面不能一直停在「翻译中…」。
    useConversationStore.getState().cancelPendingTranslations();
    useUiStore.getState().setPlayback('playing');
    setLevel(null);
    setStatus('paused');
  }, [setStatus, setLevel, setBusy, getTts, cancelFactRequests]);

  const toggleListening = useCallback(async () => {
    const current = useUiStore.getState().status;
    /*
     * 0.6.3：只用共享判据。旧版自己写 `listening || starting`，漏了
     * `no-audio` —— 「采集中，暂未收到声音」时点按钮显示「暂停」，
     * 实际却调 startListening 重新开始采集，用户以为已经停了。
     * 现在 starting / listening / no-audio 一律无条件停止。
     */
    if (captureAction(current) === 'stop') await stopListening();
    else await startListening();
  }, [startListening, stopListening]);

  // ---- restart the demo pipeline when sample-chat / language changes -----
  const demoAutoPlay = settings.demoAutoPlay;
  const targetLanguage = settings.targetLanguage;
  const scenarioMode = settings.scenarioMode;
  const bootedRef = useRef(false);
  useEffect(() => {
    if (!bootedRef.current) {
      bootedRef.current = true;
      return;
    }
    if (!useSettingsStore.getState().settings.mockMode) return;
    if (useUiStore.getState().status !== 'listening') return;
    // Recreate the engine so the new switch state / language takes effect now.
    void window.copilot.audioStart();
  }, [demoAutoPlay, targetLanguage]);

  // Leaving video / exam mode always returns the playback indicator to normal.
  useEffect(() => {
    if (scenarioMode === 'conversation') useUiStore.getState().setPlayback('playing');
  }, [scenarioMode]);

  // ---- AI replies --------------------------------------------------------
  const requestReplies = useCallback(
    async (
      mode: CopilotMode,
      options?: { current?: string; chinese?: string; reveal?: boolean },
    ): Promise<boolean> => {
      const config = settingsRef.current;
      const fromChinese = mode === 'from-chinese';
      const compose = useUiStore.getState();
      if (fromChinese) {
        compose.setCompose({
          submitted: options?.chinese ?? '',
          phase: 'pending',
          error: '',
          resultCount: 0,
        });
      }
      /*
       * 请求一开始就把「用哪份上下文、算第几轮、编号是多少」全部定下来。
       *
       * 旧实现是在**结果回来时**才读 `roundIndex`，于是十秒里对方又说了一句
       * 之后，这批回复会被标成新一轮的 —— 界面提示和实际内容错位。
       * 上下文同理：发出去的是当时那句话，回来时不该被后来的字幕改写。
       */
      const seq = (replySeqRef.current += 1);
      // 新请求让旧的作废，并且**真的掐断**它 —— 只丢结果的话，用户每改一次
      // 语气就会白烧一次十几秒的生成额度。
      if (lastReplyReqRef.current) void window.copilot.aiCancel(lastReplyReqRef.current);
      const requestId = `rp:${seq}`;
      lastReplyReqRef.current = requestId;
      const round = useConversationStore.getState().roundIndex;
      const context = contextText();

      // Asking for a reply while watching something means the video is paused.
      if (config.scenarioMode !== 'conversation') {
        useUiStore.getState().setPlayback('paused');
      }
      repliesPendingRef.current += 1;
      setBusy(true);
      setError(null);
      setLastMode(mode);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // 真的掐断主进程里那次请求，不能只丢渲染层结果。
        void window.copilot.aiCancel(requestId);
      }, REPLY_TIMEOUT_MS);
      try {
        const raw = await window.copilot.aiReply({
          context,
          mode,
          current: options?.current,
          chinese: options?.chinese,
          tone: config.tone,
          scenario: config.scenarioMode,
          requestId,
        });
        // 已经有更新的请求了 → 这一份是旧答案，丢掉，别覆盖新的。
        if (seq !== replySeqRef.current || timedOut) {
          window.copilot.log('INFO', 'Renderer', `drop stale reply #${seq}`);
          return false;
        }
        const drafts = JSON.parse(raw) as ReplyDraft[];
        // reveal=false 表示这批回复是自动来的，不许把用户打开的面板抢走 ——
        // 详见 shared/reply-reveal.ts。
        setSuggestions(
          drafts.map((draft) => toSuggestion(draft, config.hintSystem ?? 'hanzi')),
          round,
          {
          reveal: options?.reveal ?? true,
        });
        if (fromChinese) {
          useUiStore.getState().setCompose({
            phase: drafts.length ? 'success' : 'error',
            error: drafts.length ? '' : '没有生成可用回复，草稿已保留，可点重试。',
            resultCount: drafts.length,
          });
        }
        return drafts.length > 0;
      } catch (error) {
        // 过时的失败同样不弹错：用户等的是新的那一次。
        if (seq !== replySeqRef.current) return false;
        // 把英文报错翻成人话：告诉用户哪里错了 + 怎么改，而不是「失败了」。
        const info = describeAiError(error);
        const message = timedOut
          ? `生成超时（超过 ${Math.round(REPLY_TIMEOUT_MS / 1000)} 秒）｜草稿已保留，可点「重试」。`
          : `${info.title}｜${info.hint}。草稿已保留，可点「重试」。`;
        setError(message);
        if (fromChinese) {
          useUiStore.getState().setCompose({ phase: 'error', error: message, resultCount: 0 });
        }
        /*
         * 日志只记错误码。
         *
         * `info.raw` 是服务商返回的原文，里面可能带着我们发过去的请求体回显
         * —— 也就是对方刚说的话和你的整段上下文。写进 app.log 就等于把对话
         * 正文落到了磁盘上，这正是「音频和对话正文不落盘」要守住的那条线。
         */
        window.copilot.log(
          'ERROR',
          'Renderer',
          `reply failed: ${timedOut ? 'TIMEOUT' : info.code}`,
        );
        return false;
      } finally {
        clearTimeout(timer);
        // 用计数而不是布尔：A、B 并发时，A 先结束不能把 B 的忙碌态一起关掉。
        repliesPendingRef.current = Math.max(0, repliesPendingRef.current - 1);
        if (repliesPendingRef.current === 0) setBusy(false);
      }
    },
    [contextText, setBusy, setError, setLastMode, setSuggestions],
  );

  /** Pause the video mentally and immediately draft a reply. */
  const pauseAndReply = useCallback(async () => {
    useUiStore.getState().setPlayback('paused');
    if (pauseTimerRef.current) {
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
    // 静默看门狗自己发起的：即使中途用户打开了设置，也不许把面板抢走。
    await requestReplies('reply', { reveal: false });
  }, [requestReplies]);
  pauseAndReplyRef.current = pauseAndReply;

  /** The video is running again — stop waiting for a reply. */
  const resumePlayback = useCallback(() => {
    useUiStore.getState().setPlayback('playing');
    if (pauseTimerRef.current) {
      clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
  }, []);

  /**
   * 改了「回复风格 / 回复长度 / 语言水平 / 语气」之后，如果回复面板正开着，
   * 立刻按新设置重出三张卡片。
   *
   * 不这么做的话：用户在设置里把风格从「自然」改成「幽默」，面板上还是上一版
   * 的回复，看起来就像"风格根本切不了"（用户原话）。这里先清空旧回复，让界面
   * 明确显示「正在按新风格重新生成」，而不是新旧混在一起。
   */
  // 等级要按当前对话语言取：日语用户改的是 ja-n3，不是 cet4。语言本身也进签名 ——
  // 从英语切到日语，旧的三张卡已经不成立了，必须重出。
  const styleSignature = `${settings.replyStyle}|${settings.responseLength}|${levelFor(
    settings.languageLevels,
    settings.targetLanguage,
  )}|${settings.tone}|${settings.targetLanguage}`;
  const lastStyleSignatureRef = useRef(styleSignature);
  useEffect(() => {
    if (lastStyleSignatureRef.current === styleSignature) return;
    lastStyleSignatureRef.current = styleSignature;
    const ui = useUiStore.getState();
    if (!ui.suggestions.length || ui.busy) return;
    window.copilot.log(
      'INFO',
      'Renderer',
      `style/length/level changed -> regenerate (${styleSignature})`,
    );
    ui.setSuggestions([]);
    // reveal=false：用户此刻正开在设置页改这一项，新回复十几秒后回来时不能把
    // 面板关掉（这是真实踩到的「设置面板自己消失」）。
    void requestReplies('reply', { reveal: false });
  }, [styleSignature, requestReplies]);

  const setScenario = useCallback(async (mode: ScenarioMode) => {
    await useSettingsStore.getState().update({ scenarioMode: mode });
    useUiStore.getState().setPlayback('playing');
  }, []);

  /** Alt+V: jump straight into / out of video mode. */
  const toggleVideoMode = useCallback(() => {
    const next: ScenarioMode =
      useSettingsStore.getState().settings.scenarioMode === 'conversation'
        ? 'video'
        : 'conversation';
    void setScenario(next);
  }, [setScenario]);

  // ---- dismiss the AI suggestions ---------------------------------------
  const closeReplies = useCallback(() => {
    /*
     * 关闭面板 = 「这一批我不要了」。
     *
     * 旧实现只把现有的清掉，但**在途的请求还活着**：十几秒后它回来，
     * `setSuggestions` 又把面板弹出来了 —— 用户明明关了，它自己又开。
     * 现在把编号推进一格，所有在途请求回来时都对不上，直接丢弃。
     */
    replySeqRef.current += 1;
    repliesPendingRef.current = 0;
    speakSeqRef.current += 1;
    // 关掉面板 = 连在途的生成也不要了：让主进程真的 abort，别白烧一次额度。
    if (lastReplyReqRef.current) {
      void window.copilot.aiCancel(lastReplyReqRef.current);
      lastReplyReqRef.current = '';
    }
    try {
      getTts().stop();
    } catch {
      /* ignore */
    }
    setSpeakingId(null);
    setBusy(false);
    setSuggestions([]);
    setError(null);
  }, [getTts, setBusy, setSpeakingId, setSuggestions, setError]);

  // ---- shortcuts ---------------------------------------------------------
  useEffect(() => {
    const off = window.copilot.onShortcut((action) => {
      switch (action) {
        case 'reply':
          void requestReplies('reply');
          break;
        case 'didnt-catch':
          void requestReplies('didnt-catch');
          break;
        case 'continue':
          void requestReplies('continue');
          break;
        case 'toggle-pause':
          void toggleListening();
          break;
        case 'close-replies':
          closeReplies();
          break;
        case 'toggle-video':
          toggleVideoMode();
          break;
      }
    });
    return off;
  }, [requestReplies, toggleListening, closeReplies, toggleVideoMode]);

  // ---- tray "start/pause listening" --------------------------------------
  useEffect(() => window.copilot.onTrayToggleListening(() => void toggleListening()), [toggleListening]);

  // ---- speech ------------------------------------------------------------
  const speak = useCallback(
    async (text: string, id?: string, speedOverride?: number, chunks?: string[]) => {
      const seq = (speakSeqRef.current += 1);
      const provider = getTts();
      if (id) setSpeakingId(id);
      try {
        const settings = settingsRef.current;
        // 读的是**目标原文**，语言标签要跟着目标语言与口音，不能一律 en-US。
        const lang = bcp47For(settings.targetLanguage, settings.accent);
        /*
         * 分段朗读（短语重复）。
         *
         * 传了 `chunks` 就一段一段念，每段之间留一口气 —— 这是「短语练习」，
         * 不是把单词随便切碎：这些块来自真实的分块结果（syllables / 音拍），
         * 而且整段仍然是同一个语速、同一个语音。
         */
        const parts = chunks?.length && chunks.length > 1 ? chunks : [text];
        for (const part of parts) {
          // 停止 / 换句之后不再念下一段。
          if (seq !== speakSeqRef.current) break;
          await provider.speak({
            text: part,
            voice: settings.ai.ttsVoice,
            // 慢速播放（0.7x）在云端朗读和系统朗读两条路上都要生效。
            speed: speedOverride ?? settings.ai.ttsSpeed ?? 1,
            lang,
          });
          if (parts.length > 1 && seq === speakSeqRef.current) {
            await new Promise((resolve) => setTimeout(resolve, 240));
          }
        }
      } catch (error) {
        // 只记错误名/错误码：TTS 的报错里可能带着要朗读的那句话本身。
        const code =
          (error as { code?: string } | null)?.code ??
          (error instanceof Error ? error.name : 'unknown');
        window.copilot.log('ERROR', 'Renderer', `tts failed: ${code}`);
        /*
         * 没有目标语言的语音时要说清楚。
         *
         * 以前这种情况静默退回英语：用户点「朗读日语」，听到一段英语腔，
         * 界面却显示播放成功 —— 他只会以为软件发音很差。
         */
        if (code === 'TTS_LANG_UNAVAILABLE') {
          const tag = bcp47For(settingsRef.current.targetLanguage, settingsRef.current.accent);
          setError(`这台电脑没有装「${tag}」的朗读语音｜在 Windows 设置 → 时间和语言 → 语言里添加该语言（含语音包），或改用云端朗读`);
        }
      } finally {
        // 只有「还是最新这一次」才清播放标记：连点两张卡时，先结束的那句
        // 不能把后一句的播放状态清掉。
        if (seq === speakSeqRef.current) setSpeakingId(null);
      }
    },
    [getTts, setSpeakingId],
  );

  const stopSpeaking = useCallback(() => {
    speakSeqRef.current += 1;
    getTts().stop();
    setSpeakingId(null);
  }, [getTts, setSpeakingId]);

  return useMemo(
    () => ({
      settings,
      scenarioMode,
      startListening,
      listenToSystemAudio,
      stopListening,
      toggleListening,
      requestReplies,
      pauseAndReply,
      resumePlayback,
      setScenario,
      toggleVideoMode,
      closeReplies,
      speak,
      stopSpeaking,
      retryTranslate,
      clearConversation,
      reconnectAudio,
    }),
    [
      settings,
      scenarioMode,
      startListening,
      listenToSystemAudio,
      stopListening,
      toggleListening,
      requestReplies,
      pauseAndReply,
      resumePlayback,
      setScenario,
      toggleVideoMode,
      closeReplies,
      speak,
      stopSpeaking,
      retryTranslate,
      clearConversation,
      reconnectAudio,
    ],
  );
}
