import { useEffect, useMemo, useRef, useState } from 'react';
import { removeCustomReading, upsertCustomReading } from '../../shared/reading-dictionary';
import { useConversationStore } from '../stores/conversation';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { buildHintPlan, type HintPlan } from '../../services/pronunciation';
import type { HintSystem } from '../../shared/languages';
import { hintSystemLabel } from '../../shared/languages';
import { translationView } from '../../shared/subtitle-state';
import { readingPrefs } from '../../shared/reading';
import type { ConversationItem } from '../../shared/types';
import { useHistoryStore } from '../stores/history';
import { saveStateLabel } from '../lib/history-sync';
import { AudioDiagnostics } from './AudioDiagnostics';
import { IconSpeaker, IconWarn } from './icons';

/**
 * 一行译文。
 *
 * 四种状态各有各的样子：翻译中（灰）、成功（正文）、失败（红 + 原因 + 重试）、
 * 已停止翻译（灰 + 重试）。
 *
 * 0.4.0 的两个改动：
 * 1. 字号**不再比原文小**：译文是主要阅读对象，默认 23px，原文 15px。
 * 2. 失败时把「为什么失败 + 下一步做什么」写出来。以前只有一个「翻译失败」，
 *    断网、Key 过期、余额不足看起来一模一样。
 */
function TranslationLine({
  item,
  fontSize,
  highContrast,
  onRetry,
}: {
  item: ConversationItem;
  fontSize: number;
  highContrast: boolean;
  onRetry: () => void;
}) {
  const view = translationView(item);

  if (view.state === 'ok') {
    return (
      <p
        data-translation-state="ok"
        className={`mt-1 leading-[1.45] ${highContrast ? 'text-white' : 'text-white/[0.88]'}`}
        style={{ fontSize: `${fontSize}px` }}
      >
        {item.translatedText}
      </p>
    );
  }
  if (!view.placeholder) return null;
  const failed = view.state === 'failed';
  return (
    <div data-translation-state={view.state} className="mt-1">
      <p
        className={`flex flex-wrap items-center gap-1.5 leading-[1.45] ${
          failed ? 'text-danger' : 'text-white/45'
        }`}
        style={{ fontSize: `${fontSize}px` }}
      >
        <span>{view.placeholder}</span>
        {view.canRetry && (
          <button
            type="button"
            data-translation-retry
            onClick={onRetry}
            aria-label="重新翻译这一句"
            className={`no-drag rounded-md px-1.5 py-[2px] text-[11px] transition-colors ${
              failed
                ? 'bg-danger/15 text-danger hover:bg-danger/25'
                : 'bg-ink-700 text-white/60 hover:bg-ink-600 hover:text-white/85'
            }`}
          >
            重试
          </button>
        )}
      </p>
      {/*
        * 原因必须写出来，而且要短：一句话说清「哪里错了」，再用小字说「怎么办」。
        * 不含服务商原始响应（那里面可能有你说过的话）。
        */}
      {failed && item.translationError && (
        <p data-translation-reason className="mt-0.5 text-[11px] leading-relaxed text-danger/75">
          {item.translationError.title} · {item.translationError.hint}
        </p>
      )}
      {/* 高对比模式下「翻译中」也要有足够亮度，不能靠淡灰表示状态。 */}
      {!failed && highContrast && view.state === 'pending' && (
        <span className="sr-only">正在翻译</span>
      )}
    </div>
  );
}

export function SubtitleList({
  recordsCount,
  onNewSession,
  onOpenRecords,
  recent,
  onResume,
  onListen,
  onSpeak,
  onRetryTranslate,
  onLoadEarlier,
  highlightId,
  onHighlightHandled,
}: {
  recordsCount: number;
  onNewSession: () => void;
  onOpenRecords: () => void;
  /** 库里最近的那一段（关闭重开后给一个「打开上次记录」的入口）。 */
  recent?: { id: string; title: string; messageCount: number } | null;
  onResume?: () => void;
  onListen: () => void;
  /** 朗读某条字幕（学语言时最常用的动作：跟着念一遍）。 */
  onSpeak: (text: string, id: string) => void;
  /** 重新翻译某一句（翻译失败 / 中途停止之后的补救）。 */
  onRetryTranslate: (id: string) => void;
  /** 看历史记录时向上加载更早的一页。 */
  onLoadEarlier: () => Promise<number>;
  /** 从「重点信息」点过来时要定位到的那句字幕。 */
  highlightId?: string | null;
  onHighlightHandled?: () => void;
}) {
  const items = useConversationStore((state) => state.items);
  const marks = useConversationStore((state) => state.marks);
  const hasEarlier = useConversationStore((state) => state.hasEarlier);
  const roundIndex = useConversationStore((state) => state.roundIndex);
  const clear = useConversationStore((state) => state.clear);
  const subtitle = useSettingsStore((state) => state.settings.subtitle);
  const pronunciation = useSettingsStore((state) => state.settings.pronunciation);
  const targetLanguage = useSettingsStore((state) => state.settings.targetLanguage);
  const hintSystem = useSettingsStore(
    (state) => (state.settings.hintSystem ?? 'hanzi') as HintSystem,
  );
  const speakingId = useUiStore((state) => state.speakingId);
  const saveState = useHistoryStore((state) => state.saveState);
  const pendingCount = useHistoryStore((state) => state.pendingCount);
  const containerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  /** 字号 / 阅读模式 / 高对比，统一由 shared/reading.ts 规整（有单测）。 */
  const prefs = useMemo(() => readingPrefs(subtitle), [subtitle]);
  const showTranslation = subtitle.showTranslation && prefs.readingMode !== 'original-only';

  /**
   * 每句外语原文的中文谐音。
   *
   * 优先用**已保存**的 `item.romanization`：历史记录里显示的是当时那行字，
   * 不能因为本地引擎后来改了算法就变样。只有在还没有保存值时才现算
   * （本地规则引擎，不花任何模型额度）。
   *
   * 受设置里的开关控制；关掉只是不显示，已保存的内容不会被删除 ——
   * 再打开就还在。
   */
  const showHint = pronunciation.readingHint ?? pronunciation.chinesePronunciation;

  /*
   * 读音提示按**片段**算，不按整句算。
   *
   * 整句字符串没法回答「这个词怎么念」，界面上也就没法点词看读音。
   * 这里给每个词一个带原文范围的片段（`HintSegment`），原文改了范围对不上，
   * 提示自然失效 —— 这就是「提示必须和原句对应」的落地方式。
   */
  const hintPlans = useMemo(() => {
    const map = new Map<string, HintPlan>();
    if (!showHint) return map;
    for (const item of items) {
      if (item.speaker !== 'foreign' || item.partial) continue;
      // 历史记录里存了「当时用的体系」就按当时那个体系算：
      // 换过理解语言之后，旧句子不该被当成新体系去标读音。
      const system = (item.hintSystem as HintSystem | undefined) ?? hintSystem;
      const plan = buildHintPlan(
        item.originalText,
        targetLanguage,
        system,
        // 个人词表优先于规则：用户填过的名字、术语要用他自己的读法。
        useSettingsStore.getState().settings.pronunciation?.customReadings,
      );
      if (plan.text) map.set(item.id, plan);
    }
    return map;
    // 词表变了要重算：用户刚存下的读法必须立刻生效。
  }, [items, showHint, targetLanguage, hintSystem, pronunciation.customReadings]);

  /** 点中的片段（`itemId:segId`）：原文与提示行同时高亮。 */
  const [activeSeg, setActiveSeg] = useState<string | null>(null);
  /** 「改读法」输入框的内容（选中片段时用当前读法预填）。 */
  const [editValue, setEditValue] = useState('');

  useEffect(() => {
    if (!activeSeg) {
      setEditValue('');
      return;
    }
    const [itemId, segId] = activeSeg.split(':');
    const plan = hintPlans.get(itemId);
    const segment = plan?.segments.find((item) => item.id === segId);
    setEditValue(segment?.hint ?? '');
  }, [activeSeg, hintPlans]);

  /**
   * 把用户对这个词的读音存进个人词表。
   *
   * 存的是「词 + 读法 + 提示体系」三件套：同一个词在汉字近音和片假名下是
   * 两种写法，不能互相顶掉。存完立刻重算（`customReadings` 变化会触发 useMemo）。
   */
  const saveReading = (word: string, reading: string, system: HintSystem, itemId: string) => {
    const settings = useSettingsStore.getState().settings;
    const value = reading.trim();
    if (!word.trim() || !value) return;
    const next = upsertCustomReading(settings.pronunciation?.customReadings, {
      word,
      reading: value,
      system,
    });
    void useSettingsStore.getState().update({
      pronunciation: { ...settings.pronunciation, customReadings: next },
    });
    /*
     * 只更新设置是不够的。
     *
     * 字幕行优先显示**已保存的那行字**（历史记录要还原当时看到的样子）。
     * 用户刚把这句的读法改掉，如果不同时把这一行的保存值刷新，界面就会
     * 继续显示旧读音 —— 设置改了、屏幕没变，用户以为没生效。
     * 所以这里按新的词表重算这一句，并把结果写回这条字幕。
     */
    const item = useConversationStore.getState().items.find((entry) => entry.id === itemId);
    const plan = item
      ? buildHintPlan(item.originalText, targetLanguage, system, next)
      : null;
    if (plan?.text) {
      useConversationStore.getState().setRomanization(itemId, plan.text, system, plan.version);
    }
    setActiveSeg(null);
  };

  /** 「用回默认」：删掉这条自定义，回到规则引擎的结果。 */
  const resetReading = (word: string, system: HintSystem, itemId: string) => {
    const settings = useSettingsStore.getState().settings;
    const next = removeCustomReading(settings.pronunciation?.customReadings, { word, system });
    void useSettingsStore.getState().update({
      pronunciation: { ...settings.pronunciation, customReadings: next },
    });
    const item = useConversationStore.getState().items.find((entry) => entry.id === itemId);
    const plan = item
      ? buildHintPlan(item.originalText, targetLanguage, system, next)
      : null;
    if (plan?.text) {
      useConversationStore.getState().setRomanization(itemId, plan.text, system, plan.version);
    }
    setActiveSeg(null);
  };

  /**
   * 字幕和「这里少了一句」标记按时间混排。
   *
   * 不混排的话，标记只能追加在最后，用户根本不知道它对应哪一段 ——
   * 而「漏掉的是哪一句」正是这个标记唯一有价值的信息。
   */
  const rows = useMemo(() => {
    type Row =
      | { kind: 'item'; at: number; item: ConversationItem }
      | { kind: 'mark'; at: number; id: string; reason: string };
    const out: Row[] = [
      ...items.map((item) => ({ kind: 'item' as const, at: item.timestamp, item })),
      ...marks.map((mark) => ({
        kind: 'mark' as const,
        at: mark.at,
        id: mark.id,
        reason: mark.reason,
      })),
    ];
    return out.sort((a, b) => a.at - b.at);
  }, [items, marks]);

  // Scroll freely: auto-follow only while the user stays near the bottom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows]);

  /*
   * 从「重点信息」点过来：滚到那句话 + 高亮 1.6 秒。
   *
   * 注意这里要临时关掉「自动跟随底部」—— 否则刚滚上去，下一条字幕一来又被
   * 拉回底部，用户根本看不到自己点的那句。
   */
  useEffect(() => {
    if (!highlightId) return;
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(
      `[data-subtitle-id="${highlightId}"]`,
    );
    if (!target) return;
    followRef.current = false;
    setAtBottom(false);
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.dataset.highlight = 'on';
    const timer = setTimeout(() => {
      delete target.dataset.highlight;
      onHighlightHandled?.();
    }, 1600);
    return () => {
      clearTimeout(timer);
      delete target.dataset.highlight;
    };
  }, [highlightId, onHighlightHandled]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distance < 48;
    followRef.current = bottom;
    setAtBottom(bottom);
  };

  const jumpToLatest = () => {
    const el = containerRef.current;
    if (!el) return;
    followRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  /**
   * 加载更早的一页，并把滚动位置钉在用户正在看的那一句上。
   *
   * 不钉的话，顶上插进来 50 条 → 内容整体下移 → 用户眼前换成了别的话，
   * 会以为自己点错了。用「加载前后 scrollHeight 的差值」反推偏移量。
   */
  const handleLoadEarlier = async () => {
    const el = containerRef.current;
    if (!el || loadingEarlier) return;
    const beforeHeight = el.scrollHeight;
    const beforeTop = el.scrollTop;
    followRef.current = false;
    setLoadingEarlier(true);
    try {
      await onLoadEarlier();
    } finally {
      // 两帧之后再量：React 提交 + 浏览器布局都要时间。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const after = containerRef.current;
          if (after) {
            const delta = after.scrollHeight - beforeHeight;
            if (delta > 0) after.scrollTop = beforeTop + delta;
          }
          setLoadingEarlier(false);
        });
      });
    }
  };

  if (!items.length) {
    return (
      <div data-subtitle-list className="flex min-h-[88px] flex-1 flex-col">
        <AudioDiagnostics onListen={onListen} />
        {/*
          空状态最容易误会成「记录丢了」。
          关掉软件再打开，字幕区一定是空的 —— 数据在库里，但用户看到的是
          一片黑。所以这里直接把最近一段摆出来，一句话说清它还在、有几条。
        */}
        {recent && (
          <div
            data-resume-last
            className="mx-3 mb-2 rounded-xl border border-line-soft bg-ink-850 px-2.5 py-2"
          >
            <p className="text-[10.5px] text-white/40">上次的记录还在本机</p>
            <p data-resume-last-title className="mt-0.5 truncate text-[12px] text-white/85">
              {recent.title}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="text-[10px] text-white/35">{recent.messageCount} 条消息</span>
              <button
                type="button"
                data-resume-last-open
                onClick={() => onResume?.()}
                aria-label={`打开上次的记录：${recent.title}，${recent.messageCount} 条消息`}
                className="ml-auto rounded-lg border border-accent/40 bg-accent/12 px-2 py-1 text-[10.5px]
                  font-medium text-accent-soft transition-colors hover:bg-accent/20"
              >
                打开这段
              </button>
            </div>
          </div>
        )}
        <div className="flex shrink-0 items-center justify-center gap-1.5 pb-2.5">
          <button
            type="button"
            data-new-session
            onClick={onNewSession}
            className="btn-ghost !py-1 !text-[10.5px]"
          >
            ＋新记录
          </button>
          <button
            type="button"
            data-open-records
            onClick={onOpenRecords}
            className="btn-ghost !py-1 !text-[10.5px]"
          >
            记录{recordsCount ? ` ${recordsCount}` : ''}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-subtitle-list className="relative flex min-h-[88px] flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="label truncate !text-white/45">对话 {items.length} 条</span>
          {roundIndex > 0 && (
            <span
              data-subtitle-round
              className="tnum shrink-0 rounded-full bg-ink-800 px-1.5 py-[1px] text-[9.5px] text-white/50"
            >
              第 {roundIndex} 轮
            </span>
          )}
          {/* 保存状态：只有主进程回执才算「已保存」，失败时可在这里直接重试。 */}
          <span
            data-save-state={saveState}
            title={
              saveState === 'failed'
                ? '这一场的内容还没写进记录文件，点「重试保存」'
                : '内容已写入本机记录文件，关掉软件也不会丢'
            }
            className={`shrink-0 rounded-full px-1.5 py-[1px] text-[9.5px] ${
              saveState === 'failed'
                ? 'bg-danger/15 text-danger'
                : saveState === 'saved'
                  ? 'bg-ok/12 text-ok/80'
                  : 'bg-ink-800 text-white/40'
            }`}
          >
            {saveStateLabel(saveState, pendingCount)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-new-session
            onClick={onNewSession}
            title="把当前对话存成一条记录，然后开一段新对话"
            aria-label="把当前对话存成记录并开始新对话"
            className="rounded-lg px-1.5 py-0.5 text-[10px] text-white/45 transition-colors hover:bg-ink-700 hover:text-white/80"
          >
            ＋新记录
          </button>
          <button
            type="button"
            data-open-records
            onClick={onOpenRecords}
            title="查看对话记录"
            aria-label="查看对话记录"
            className="rounded-lg px-1.5 py-0.5 text-[10px] text-white/45 transition-colors hover:bg-ink-700 hover:text-white/80"
          >
            记录{recordsCount ? ` ${recordsCount}` : ''}
          </button>
          <button
            type="button"
            onClick={clear}
            title="清空当前对话（不影响已保存的记录）"
            aria-label="清空当前对话，不影响已保存的记录"
            className="rounded-lg px-1.5 py-0.5 text-[10px] text-white/35 transition-colors hover:bg-ink-700 hover:text-white/70"
          >
            清空
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-contrast={prefs.highContrast ? 'high' : 'normal'}
        className="subtle-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-2 pt-1"
      >
        {/*
          看历史记录时，顶部先给「加载更早」。
          加载后把滚动位置钉回原来那句，不会跳走 —— 用户正在读的内容不能因为
          「上面又插进来 50 条」而移位。
        */}
        {hasEarlier && (
          <button
            type="button"
            data-load-earlier
            disabled={loadingEarlier}
            onClick={() => void handleLoadEarlier()}
            className="no-drag mx-auto block rounded-full border border-line px-3 py-1 text-[10.5px]
              text-white/55 transition-colors hover:bg-ink-800 hover:text-white disabled:opacity-40"
          >
            {loadingEarlier ? '正在加载…' : '↑ 加载更早的内容'}
          </button>
        )}
        {rows.map((row) => {
          if (row.kind === 'mark') {
            /*
             * 「这里少了一句」的标记。
             *
             * 它不是装饰，是信息完整性声明：用户有权知道自己漏了什么。
             * 所以用带边框的显式块，而不是一行灰字。
             */
            return (
              <div
                key={row.id}
                data-subtitle-mark
                role="note"
                className="flex items-start gap-1.5 rounded-lg border border-dashed border-warn/40
                  bg-warn/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-warn"
              >
                <IconWarn size={12} />
                <span>这里有一段没转写：{row.reason}</span>
              </div>
            );
          }

          const item = row.item;
          const foreign = item.speaker === 'foreign';
          const lowConfidence =
            subtitle.showConfidenceWarning &&
            typeof item.confidence === 'number' &&
            item.confidence < 0.8;
          const partial = Boolean(item.partial);
          // 阅读模式：先看译文时，译文在上、原文折叠到下面一小行。
          const translationFirst = prefs.readingMode === 'translation-first';

          const plan = hintPlans.get(item.id);
          /*
           * 保存下来的那行字，和「按当前设置现算」的结果一模一样时，就用现算的
           * 片段来渲染 —— 这样每个词都能点、能和原文联动。
           *
           * 不一样的时候（换了理解语言、或算法升级过）必须显示**保存的那行**：
           * 历史记录不该被今天的规则改写。这种情况下不提供点词，因为片段和
           * 那行字对不上，点了会指错。
           */
          const planMatchesSaved = Boolean(item.romanization && plan && plan.text === item.romanization);
          const activeKey = activeSeg;
          const originalNode = (
            <p
              data-subtitle-original
              className={`leading-[1.4] ${
                partial
                  ? prefs.highContrast
                    ? 'text-white/90'
                    : 'text-white/70'
                  : foreign
                    ? prefs.highContrast
                      ? 'text-white'
                      : 'text-white/[0.95]'
                    : prefs.highContrast
                      ? 'text-white/90'
                      : 'text-white/70'
              }`}
              style={{ fontSize: `${prefs.originalFontSize}px` }}
            >
              {/*
                点词看读音。
                有提示片段时按「词」渲染成一个个可点的 span，点哪个词就把
                原文和下面那行读音同时点亮 —— 这样「这串音对应的是哪个词」
                不需要用户自己去数。没有片段（比如识别中）就退回纯文本。
              */}
              {plan?.segments.length ? (
                <WordSpans
                  text={item.originalText}
                  plan={plan}
                  itemId={item.id}
                  active={activeSeg}
                  onPick={(key) => setActiveSeg((current) => (current === key ? null : key))}
                />
              ) : (
                item.originalText
              )}
            </p>
          );

          return (
            <div
              key={item.id}
              data-subtitle-item
              data-subtitle-id={item.id}
              data-subtitle-partial={partial ? 'true' : 'false'}
              className="group rounded-xl px-2 py-1.5 transition-colors duration-150
                hover:bg-ink-850/70 data-[highlight=on]:bg-accent/12
                data-[highlight=on]:ring-1 data-[highlight=on]:ring-accent/40"
            >
              <div className="mb-1 flex items-center gap-1.5">
                <span
                  className={`chip ${
                    foreign ? 'bg-accent/15 text-accent-soft/90' : 'bg-ok/12 text-ok/90'
                  }`}
                >
                  {foreign ? '对方' : '你'}
                </span>
                {lowConfidence && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] text-warn"
                    title={`识别置信度 ${item.confidence?.toFixed(2)}`}
                  >
                    <IconWarn size={11} /> 可能识别有误
                  </span>
                )}
                {/* 临时结果 vs 最终结果：文字 + 边框都要能看出来，不只靠颜色。 */}
                {partial && (
                  <span
                    data-subtitle-pending-label
                    className="rounded-full border border-warn/40 px-1.5 py-[1px] text-[10px] text-warn"
                  >
                    正在识别…
                  </span>
                )}

                {/* 朗读：看视频 / 做听力时想跟着念一遍，鼠标移上来就有。 */}
                {foreign && !item.partial && (
                  <button
                    type="button"
                    data-subtitle-speak
                    onClick={() => onSpeak(item.originalText, item.id)}
                    title="朗读这一句"
                    aria-label="朗读这一句外语原文"
                    className={`no-drag ml-auto grid h-5 w-5 shrink-0 place-items-center rounded-md
                      transition-colors duration-150 ${
                        speakingId === item.id
                          ? 'bg-accent/25 text-accent-soft'
                          : 'text-white/40 hover:bg-ink-700 hover:text-white group-hover:text-white/70'
                      }`}
                  >
                    <IconSpeaker size={12} />
                  </button>
                )}
              </div>

              {translationFirst && showTranslation && foreign ? (
                <>
                  {showTranslation && (
                    <TranslationLine
                      item={item}
                      fontSize={prefs.translationFontSize}
                      highContrast={prefs.highContrast}
                      onRetry={() => onRetryTranslate(item.id)}
                    />
                  )}
                  <div className="mt-1 opacity-80">{originalNode}</div>
                </>
              ) : (
                <>
                  {originalNode}
                  {showTranslation && foreign && (
                    <TranslationLine
                      item={item}
                      fontSize={prefs.translationFontSize}
                      highContrast={prefs.highContrast}
                      onRetry={() => onRetryTranslate(item.id)}
                    />
                  )}
                </>
              )}

              {/*
                提示行优先显示**已保存**的 `romanization`（历史记录要还原
                「当时那行字」，不能因为本地算法改了而变样）；没有保存值时才用
                现算的片段，这样才能点。
              */}
              {item.romanization && !planMatchesSaved ? (
                <p
                  data-subtitle-pron
                  data-romanization
                  data-hint-saved={item.hintSystem ?? ''}
                  title={
                    item.hintSystem && item.hintSystem !== hintSystem
                      ? `这行是保存时的${hintSystemLabel(item.hintSystem as HintSystem)}（近似标注，不等同准确发音）`
                      : '近似标注，不等同准确发音'
                  }
                  className={`mt-1 leading-snug tracking-[0.02em] ${
                    prefs.highContrast ? 'text-white' : 'text-accent-soft/80'
                  }`}
                  style={{ fontSize: `${prefs.romanizationFontSize}px` }}
                >
                  {item.romanization}
                </p>
              ) : plan ? (
                <p
                  data-subtitle-pron
                  data-romanization
                  data-hint-source={plan.system}
                  className={`mt-1 leading-snug tracking-[0.02em] ${
                    prefs.highContrast ? 'text-white' : 'text-accent-soft/80'
                  }`}
                  style={{ fontSize: `${prefs.romanizationFontSize}px` }}
                >
                  {plan.segments.map((segment, index) => {
                    const key = `${item.id}:${segment.id}`;
                    const active = activeKey === key;
                    if (!segment.hint) {
                      // 未确定读音：不装成读法，画一条虚线并说明原因。
                      return (
                        <span
                          key={key}
                          data-hint-unknown
                          title={`「${segment.source}」的读音还没确定，没有可靠来源，不猜`}
                          className={`mx-0.5 border-b border-dashed ${
                            prefs.highContrast ? 'border-white/60' : 'border-warn/50'
                          }`}
                        >
                          {segment.source}
                        </span>
                      );
                    }
                    return (
                      <span key={key}>
                        <button
                          type="button"
                          data-hint-seg
                          data-hint-active={active ? 'true' : 'false'}
                          data-hint-status={segment.status}
                          data-hint-origin={segment.origin ?? 'rule'}
                          onClick={() => setActiveSeg((current) => (current === key ? null : key))}
                          title={
                            /*
                             * 状态要分得清，而且不许把任何一种说成「已核对」：
                             * 词典命中 ≠ 母语者核对过，用户自己填的 ≠ 专家确认。
                             */
                            segment.origin === 'manual'
                              ? `「${segment.source}」→ ${segment.hint}（你自己填的读法，不是专家核对）`
                              : segment.status === 'approx'
                                ? `「${segment.source}」→ ${segment.hint}（规则拼出来的近似读法，没有人工核对）`
                                : segment.status === 'unknown'
                                  ? `「${segment.source}」的读音还没确定`
                                  : `「${segment.source}」→ ${segment.hint}（词典收录的读法，仍非母语者逐条核对）`
                          }
                          className={`no-drag rounded px-0.5 transition-colors duration-100 ${
                            segment.origin === 'manual'
                              ? 'border-b border-dotted border-accent/70 '
                              : ''
                          }${active
                              ? 'bg-accent/30 text-white'
                              : 'hover:bg-accent/15 hover:text-white'
                          } ${segment.status === 'approx' ? 'border-b border-dotted border-white/30' : ''} ${
                            segment.status === 'unknown' ? 'border-b border-dashed border-warn/50' : ''
                          }`}
                        >
                          {segment.hint}
                        </button>
                        {index < plan.segments.length - 1 &&
                        (plan.target !== 'Japanese' || plan.system === 'romaji')
                          ? ' '
                          : null}
                      </span>
                    );
                  })}
                  {plan.status === 'partial' && (
                    <span
                      data-hint-partial
                      className="ml-1.5 align-middle text-[10px] text-warn"
                      title="有几个词这里没有可靠读音，标了虚线，没有编造"
                    >
                      部分未确定
                    </span>
                  )}
                  {plan.status === 'approx' && (
                    <span
                      data-hint-approx
                      className="ml-1.5 align-middle text-[10px] text-white/55"
                      title={`有 ${plan.approximate} 段是按规则拼出来的近似读法（词典没收录，通常是生词、人名或缩写），没有经过人工核对。点那段可以自己改。`}
                    >
                      规则近似 {plan.approximate} 段
                    </span>
                  )}
                </p>
              ) : null}

              {plan && activeSeg?.startsWith(`${item.id}:`) ? (() => {
                const segId = activeSeg.slice(item.id.length + 1);
                const segment = plan.segments.find((item) => item.id === segId);
                if (!segment) return null;
                return (
                  <div
                    data-hint-editor
                    className="mt-1 rounded-lg border border-line-soft bg-ink-850 px-2 py-1.5"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-white/45">
                        「{segment.source}」读法不对？
                      </span>
                      <input
                        data-hint-edit-input
                        aria-label={`修改「${segment.source}」的读音提示`}
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            saveReading(segment.source, editValue, plan.system, item.id);
                          }
                          if (event.key === 'Escape') setActiveSeg(null);
                        }}
                        className="min-w-0 flex-1 rounded border border-line bg-ink-800 px-1 py-[1px]
                          text-[11px] text-white/90 outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        data-hint-edit-save
                        onClick={() => saveReading(segment.source, editValue, plan.system, item.id)}
                        className="no-drag rounded border border-accent/40 bg-accent/12 px-2 py-[1px]
                          text-[10.5px] text-accent-soft hover:bg-accent/20"
                      >
                        存为我的读法
                      </button>
                      {segment.origin === 'manual' && (
                        <button
                          type="button"
                          data-hint-edit-reset
                          onClick={() => resetReading(segment.source, plan.system, item.id)}
                          className="no-drag rounded border border-line px-2 py-[1px] text-[10.5px] text-white/60
                            hover:bg-ink-800 hover:text-white"
                        >
                          用回默认
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-[9.5px] leading-relaxed text-white/30">
                      存的是<b className="text-white/50">你自己的读法</b>，不算专家核对；
                      只对这一种提示体系生效。
                    </p>
                  </div>
                );
              })() : null}

              {item.correction && (
                <p className="mt-1.5 rounded-lg bg-ok/[0.08] px-2 py-1 text-[11px] text-ok/90">
                  更自然：{item.correction}
                  {item.correctionNote ? `（${item.correctionNote}）` : ''}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* 上翻历史时不抢滚动位置；要回到底部得用户自己点。 */}
      {!atBottom && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label="回到最新一条字幕"
          className="no-drag absolute bottom-2.5 left-1/2 -translate-x-1/2 rounded-full border border-line
            bg-ink-800/95 px-3 py-1 text-[11px] text-white/80 shadow-lift backdrop-blur
            transition-colors hover:bg-ink-700"
        >
          ↓ 回到最新
        </button>
      )}
    </div>
  );
}

/**
 * 把原文按「词」渲染，每个词可点。
 *
 * 只用 `HintSegment` 给出的原文范围，不自己猜边界：日语没有空格，
 * 按字数或空格切都会切出半个词，点上去对不上读音。
 */
function WordSpans({
  text,
  plan,
  itemId,
  active,
  onPick,
}: {
  text: string;
  plan: HintPlan;
  itemId: string;
  active: string | null;
  onPick: (key: string) => void;
}) {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const segment of plan.segments) {
    if (segment.from > cursor) nodes.push(text.slice(cursor, segment.from));
    const key = `${itemId}:${segment.id}`;
    const on = active === key;
    nodes.push(
      <button
        key={key}
        type="button"
        data-word-seg
        data-word-active={on ? 'true' : 'false'}
        data-word-hint-status={segment.status}
        onClick={() => onPick(key)}
        title={
          !segment.hint
            ? '这个词的读音还没确定'
            : segment.status === 'approx'
              ? `「${segment.source}」→ ${segment.hint}（规则近似，未核对）`
              : `「${segment.source}」→ ${segment.hint}`
        }
        className={`no-drag rounded px-0.5 text-left transition-colors duration-100 ${
          on ? 'bg-accent/25 text-white' : 'hover:bg-accent/12'
        } ${segment.status === 'unknown' ? 'border-b border-dashed border-warn/40' : ''} ${
          segment.status === 'approx' ? 'border-b border-dotted border-white/25' : ''
        }`}
      >
        {segment.source}
      </button>,
    );
    cursor = segment.to;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}
