import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { useConversationStore } from '../stores/conversation';
import {
  REPLY_STYLES,
  type ReplyStyle,
  type ReplySuggestion,
  type ScenarioMode,
} from '../../shared/types';
import { ReplyCard } from './ReplyCard';
import { IconClose, IconRefresh } from './icons';
import type { CopilotMode } from '../hooks/useCopilot';

interface Props {
  suggestions: ReplySuggestion[];
  /** chunks 传了就一段一段念（短语重复），见 useCopilot.speak。 */
  onSpeak: (text: string, id: string, speed?: number, chunks?: string[]) => void;
  onRefine: (mode: CopilotMode, current: string) => void;
  onClose: () => void;
}

/** The panel means something different in each scenario — label it honestly. */
const PANEL_TITLE: Record<ScenarioMode, string> = {
  conversation: 'AI 帮回复',
  video: '暂停 · 帮你回应',
  exam: '听力要点 · 参考答案',
};

export function ReplyPanel({ suggestions, onSpeak, onRefine, onClose }: Props) {
  const pronunciation = useSettingsStore((state) => state.settings.pronunciation);
  const scenario = useSettingsStore((state) => state.settings.scenarioMode);
  const replyStyle = useSettingsStore((state) => state.settings.replyStyle);
  const updateSettings = useSettingsStore((state) => state.update);
  const busy = useUiStore((state) => state.busy);
  const error = useUiStore((state) => state.error);
  const speakingId = useUiStore((state) => state.speakingId);
  const repliesRound = useUiStore((state) => state.repliesRound);
  const roundIndex = useConversationStore((state) => state.roundIndex);
  const lastForeignText = useConversationStore((state) => state.lastForeignText);

  /**
   * 这三张卡是不是「上一轮」的。
   *
   * 多轮对话里最容易出现的误会：对方换了话题、又说了新的一句，面板上还挂着
   * 上一轮的回复，用户就以为「第二轮根本没被监听」。所以新一轮一旦开始就把
   * 这件事明说出来，并给一个一键按新一轮重出的入口。
   */
  const stale = repliesRound !== null && roundIndex > repliesRound;

  /**
   * 切换回复风格。
   *
   * 只改设置就够了：useCopilot 里有个「风格变了就重出三张卡」的副作用，
   * 所以点一下会立刻看到新风格的结果，而不是继续显示旧回复。
   */
  const switchStyle = (value: ReplyStyle) => {
    if (value === replyStyle) return;
    void updateSettings({ replyStyle: value });
  };

  /**
   * 新一版回复到了就回到顶部。
   *
   * 否则面板会停在上一版的滚动位置（经常是第三张卡），用户点完风格只看到
   * 最后一张卡变了个样，很容易以为「没生效」。
   */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const firstSuggestionId = suggestions[0]?.id ?? '';
  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [firstSuggestionId]);

  if (!suggestions.length && !busy && !error) return null;

  return (
    <div
      ref={scrollerRef}
      data-reply-panel
      className="subtle-scroll max-h-[52%] min-h-[190px] space-y-2.5 overflow-y-auto border-t border-line-soft px-3 py-2"
    >
      {/* 标题 + 风格切换一起吸顶。
          风格行如果只做成普通行，面板内容一多就会滚到吸顶标题后面去 —— 截图里
          真实出现过「风格那一排看不见了」，等于又变成"切不了风格"。 */}
      <div className="sticky top-0 z-10 -mx-3 -mt-2 space-y-1.5 bg-ink-900/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              data-panel-title
              className="truncate text-[11.5px] font-semibold tracking-[0.02em] text-white/75"
            >
              {PANEL_TITLE[scenario]}
            </span>
            {repliesRound !== null && (
              <span
                data-reply-round
                className="tnum shrink-0 rounded-full bg-ink-700 px-1.5 py-[1px] text-[9.5px] text-white/45"
              >
                第 {repliesRound} 轮
              </span>
            )}
            <span className="shrink-0 text-[10px] text-white/20">Alt + X</span>
          </div>
          <button
            onClick={onClose}
            title="关闭 AI 帮回复（Alt + X）"
            className="no-drag inline-flex shrink-0 items-center gap-1 rounded-lg border border-line
              bg-ink-850 px-2 py-1 text-[11px] text-white/55 transition-colors duration-150
              hover:border-danger/40 hover:bg-danger/12 hover:text-danger"
          >
            <IconClose size={11} />
            关闭
          </button>
        </div>

        {/* 风格快捷切换：不必翻设置面板，点一下立刻按新风格重出一版。 */}
        <div
          data-style-switch
          className="subtle-scroll fade-r -mx-1 flex items-center gap-1 overflow-x-auto px-1"
        >
          <span className="label shrink-0">风格</span>
          {REPLY_STYLES.map((item) => (
            <button
              key={item.value}
              type="button"
              data-style-chip={item.value}
              title={item.hint}
              onClick={() => switchStyle(item.value)}
              className={`no-drag shrink-0 rounded-full border px-2 py-[2px] text-[10.5px]
                transition-colors duration-150 ${
                  replyStyle === item.value
                    ? 'border-accent/45 bg-accent/18 text-accent-soft'
                    : 'border-line-soft text-white/45 hover:border-line hover:text-white/80'
                }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {stale && !busy && (
        <div
          data-reply-stale
          className="flex items-start justify-between gap-2 rounded-2xl border border-warn/20 bg-warn/[0.07] px-2.5 py-2"
        >
          <div className="min-w-0 space-y-0.5">
            <p className="text-[11px] font-medium text-warn/90">新一轮已经开始了</p>
            <p className="line-clamp-2 text-[10.5px] leading-snug text-warn/55">
              {lastForeignText || '对方又说了新的一句'}
            </p>
          </div>
          <button
            data-reply-stale-refresh
            onClick={() => onRefine('reply', lastForeignText)}
            className="no-drag inline-flex shrink-0 items-center gap-1 rounded-lg bg-warn px-2 py-1
              text-[11px] font-semibold text-ink-950 transition-colors duration-150 hover:bg-warn/85"
          >
            <IconRefresh size={11} />
            按新一轮重出
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-danger/20 bg-danger/[0.08] px-2.5 py-2 text-[11.5px] leading-relaxed text-danger/90">
          {error}
        </div>
      )}

      {busy && (
        <div className="space-y-2.5">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-16 animate-pulse rounded-2xl border border-line-soft bg-ink-800/50"
            />
          ))}
        </div>
      )}

      {suggestions.map((suggestion) => (
        <ReplyCard
          key={suggestion.id}
          suggestion={suggestion}
          pronunciation={pronunciation}
          scenario={scenario}
          speaking={speakingId === suggestion.id}
          onSpeak={() => onSpeak(suggestion.english, suggestion.id)}
          onSpeakSlow={() => onSpeak(suggestion.english, suggestion.id, 0.7)}
          onSpeakPhrases={() => onSpeak(suggestion.english, suggestion.id, 0.75, suggestion.syllables)}
          onRefine={(mode) => onRefine(mode, suggestion.english)}
        />
      ))}
    </div>
  );
}
