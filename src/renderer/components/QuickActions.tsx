import { useState } from 'react';
import { useSettingsStore } from '../stores/settings';
import { TONE_LABELS, TONE_ORDER } from '../../services/tone';
import { SCENARIO_MODES, type ScenarioMode, type ToneKey } from '../../shared/types';
import { CommCards } from './CommCards';
import { SamplesPanel } from './SamplesPanel';
import { needsCompactChrome, maxFontSize } from '../../shared/reading';
import type { CopilotMode } from '../hooks/useCopilot';

interface Props {
  disabled: boolean;
  hasSuggestions: boolean;
  scenario: ScenarioMode;
  playback: 'playing' | 'paused';
  onSubmit: (chinese: string) => void;
  onAction: (mode: CopilotMode) => void;
  onCloseReplies: () => void;
  onDemoLine: () => void;
  onSetScenario: (mode: ScenarioMode) => void;
  onPauseReply: () => void;
  onResume: () => void;
  /** Leave demo mode and start capturing the real system output. */
  onListenSystem: () => void;
  /** 朗读沟通卡里的英文（只在用户点「朗读」时用到）。 */
  onSpeak: (text: string) => void;
}

/**
 * 窗口底部的操作区。
 *
 * 0.4.0 起分两层：
 *
 * **基础层（常显）** —— 只放「读不懂时马上能做的那几件事」：
 * 三张离线沟通卡（点开就显示，不联网、不花额度）、「我没听清」、
 * 「帮我回复」（次级）、「更多」。这一层加起来不到 80px，把高度让给字幕。
 *
 * **高级层（点「更多」才展开）** —— 场景、语气、中文输入、示例对话。
 * 这些以前全铺在首页上，结果最重要的一句话（对方刚说了什么）被挤到中间
 * 一小块，而最上手的三个按钮全是「生成一段更漂亮的话」。
 *
 * 主按钮只在看视频 / 四六级听力时保留整行宽度：那两个场景的核心动作确实
 * 是「暂停 → 出参考答案」，而在实时对话里核心动作是**读字幕**，不是让 AI 说话。
 */
export function QuickActions({
  disabled,
  hasSuggestions,
  scenario,
  playback,
  onSubmit,
  onAction,
  onCloseReplies,
  onDemoLine,
  onSetScenario,
  onPauseReply,
  onResume,
  onListenSystem,
  onSpeak,
}: Props) {
  const [value, setValue] = useState('');
  const [more, setMore] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const tone = useSettingsStore((state) => state.settings.tone);
  const mockMode = useSettingsStore((state) => state.settings.mockMode);
  const demoAutoPlay = useSettingsStore((state) => state.settings.demoAutoPlay);
  const pauseDetectMs = useSettingsStore((state) => state.settings.pauseDetectMs);
  const subtitle = useSettingsStore((state) => state.settings.subtitle);
  const update = useSettingsStore((state) => state.update);

  /*
   * 译文调到 26px 以上时，一行字就要占 40px 上下 —— 这时底部还留着两排按钮，
   * 字幕区就只剩两行。用户放大字号本来是为了看清，结果看得更少，等于自相矛盾。
   * 所以真做一件事：把「我没听清 / 帮我回复」并进「更多」，底栏只剩一行。
   *
   * 三类字号独立之后，判断必须看**三者里最大的那个**：只调原文或谐音
   * 一样会把字幕区撑满，只看译文会漏掉。
   */
  const compact = needsCompactChrome(maxFontSize(subtitle));

  const setTone = (next: ToneKey) => void update({ tone: next });
  const active = SCENARIO_MODES.find((mode) => mode.value === scenario);
  const watching = scenario !== 'conversation';
  const paused = playback === 'paused';

  const primaryLabel = paused
    ? '▶ 继续播放'
    : scenario === 'exam'
      ? '暂停 · 给参考答案'
      : '暂停 · 生成回复';

  return (
    /* shrink-0：主按钮永远不能被挤走 —— 窗口只有 640 高，展开事实卡 + 打开回复
         面板时宁可让上面两块让位，也不能让「暂停 / 帮我回复」掉出屏幕。 */
    <div data-quick-actions className="shrink-0 space-y-2 border-t border-line-soft px-3.5 py-2.5">
      {/* Demo mode is the #1 reason people think the app is broken: it looks
          like it is listening but it can never hear the computer. */}
      {mockMode && (
        <div
          data-demo-banner
          className="flex items-center justify-between gap-2 rounded-2xl border border-warn/15 bg-warn/[0.05] px-2.5 py-1.5"
        >
          <span className="min-w-0 text-[10.5px] leading-snug text-warn/80">
            演示模式：听不到电脑里的声音
          </span>
          <button
            type="button"
            onClick={onListenSystem}
            className="no-drag shrink-0 rounded-lg border border-warn/35 bg-warn/12 px-2 py-1
              text-[10.5px] font-semibold text-warn transition-colors duration-150 hover:bg-warn/20"
          >
            监听系统声音
          </button>
        </div>
      )}

      {/* 基础层：离线沟通卡 + 更多。常显的只有这一行 —— 字幕区因此多出约 100px。 */}
      <div className="flex items-center gap-1.5">
        <CommCards onSpeak={onSpeak} compact={compact} />

        {hasSuggestions && (
          <button
            type="button"
            onClick={onCloseReplies}
            title="关闭 AI 帮回复（Alt + X）"
            className="no-drag ml-auto shrink-0 rounded-xl border border-line px-2 py-1 text-[11px]
              text-white/55 transition-colors duration-150 hover:border-danger/40
              hover:bg-danger/12 hover:text-danger"
          >
            关闭回复
          </button>
        )}

        <button
          type="button"
          data-more-toggle
          aria-expanded={more}
          aria-controls="quick-actions-more"
          onClick={() => setMore((prev) => !prev)}
          title={more ? '收起场景、语气和输入框' : '展开场景、语气和输入框'}
          className={`no-drag shrink-0 rounded-xl px-2 py-1 text-[11px] text-white/40
            transition-colors duration-150 hover:bg-ink-850 hover:text-white/70 ${
              hasSuggestions ? '' : 'ml-auto'
            }`}
        >
          {more ? '收起' : '更多'}
        </button>
      </div>

      {/* 高级层：默认收起。场景 / 语气 / 请求类动作 / 中文输入 / 示例对话都在这里。 */}
      <div id="quick-actions-more" data-more-panel hidden={!more} className="space-y-2 pt-0.5">
        {/*
          样例入口放在「更多」里而不是首页：它是给第一次用的人（和评委）
          亲手验证用的，不是日常高频动作。但不能藏进设置 —— 那等于没有。
        */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            data-samples-open
            onClick={() => setShowSamples(true)}
            className="no-drag rounded-lg border border-line bg-ink-850 px-2 py-1 text-[10.5px]
              text-white/65 transition-colors hover:border-accent/40 hover:text-white"
            title="三组预置样例，用来验证时间 / 否定改期 / 金额纠正能不能抓对（不调用付费接口）"
          >
            三组样例
          </button>
          <span className="text-[9.5px] text-white/30">预置文本，仅演示模式可运行</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <ChipButton
            disabled={disabled}
            onClick={() => onAction('didnt-catch')}
            title="让对方再说一遍（会请求一次 AI，需要联网）"
          >
            我没听清
          </ChipButton>
          <ChipButton
            disabled={disabled}
            onClick={() => onAction('continue')}
            title="顺着刚才的话题接一句（需要联网）"
          >
            继续话题
          </ChipButton>
          <ChipButton
            disabled={disabled}
            onClick={() => onAction('reply')}
            title="按当前语境生成一句可以接的话（需要联网）"
          >
            帮我回复
          </ChipButton>
        </div>

        <div className="flex items-center gap-2">
          <span className="label shrink-0">场景</span>
          <div className="flex min-w-0 items-center gap-0.5 rounded-full bg-ink-850 p-[3px]">
            {SCENARIO_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => onSetScenario(mode.value)}
                title={mode.hint}
                aria-pressed={scenario === mode.value}
                aria-label={`场景：${mode.short}`}
                className={`seg ${scenario === mode.value ? 'seg-on' : ''}`}
              >
                {mode.short}
              </button>
            ))}
          </div>
        </div>

        {watching && (
          <p className="text-[10px] leading-relaxed text-white/30">
            {active?.hint}
            <span className="ml-1 text-white/20">
              （对方停顿 {Math.round(pauseDetectMs / 1000)}s 会自动生成回复）
            </span>
          </p>
        )}

        <div className="flex items-center gap-2">
          <span className="label shrink-0">语气</span>
          <div className="subtle-scroll fade-r -mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1">
            {TONE_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTone(key)}
                aria-pressed={tone === key}
                aria-label={`语气：${TONE_LABELS[key]}`}
                className={`seg ${tone === key ? 'seg-on' : ''}`}
              >
                {TONE_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value.trim()) {
                onSubmit(value.trim());
                setValue('');
              }
            }}
            aria-label="输入你想让对方听到的中文，按回车转成外语"
            placeholder="输入你想说的中文……"
            className="no-drag min-w-0 flex-1 rounded-xl border border-line-soft bg-ink-850 px-2.5 py-2
              text-[12px] text-white/90 placeholder:text-white/25 transition-colors duration-150
              focus:border-accent/45 focus:outline-none"
          />
          <button
            type="button"
            disabled={disabled || !value.trim()}
            onClick={() => {
              onSubmit(value.trim());
              setValue('');
            }}
            className="no-drag shrink-0 rounded-xl border border-line px-2.5 py-2 text-[12px]
              text-white/65 transition-colors duration-150 hover:bg-ink-800 hover:text-white
              disabled:opacity-30"
          >
            转成外语
          </button>
        </div>

        {mockMode && (
          <div className="flex flex-wrap items-center gap-1.5">
            <ChipButton onClick={onDemoLine} title="手动来一句示例对话">
              说一句示例
            </ChipButton>
            <ChipButton onClick={() => void update({ demoAutoPlay: !demoAutoPlay })}>
              自动播放示例：{demoAutoPlay ? '开' : '关'}
            </ChipButton>
          </div>
        )}
      </div>

      {/* 看视频 / 听力：这两个场景的主动作确实是「暂停 → 出答案」，保留整行。 */}
      {watching && (
        <button
          type="button"
          data-primary-action={paused ? 'resume' : 'pause'}
          onClick={paused ? onResume : onPauseReply}
          className={`no-drag w-full rounded-xl py-2.5 text-[13px] font-semibold transition-colors
            duration-150 ${
              paused
                ? 'border border-line bg-ink-800 text-white/85 hover:bg-ink-700'
                : 'bg-accent text-white hover:bg-accent-dim'
            }`}
        >
          {primaryLabel}
          {!paused && <span className="text-[11px] font-normal opacity-60">　Alt + Space</span>}
        </button>
      )}

      {/* 样例面板走 portal 挂到 body 上，所以放在这里只是为了「跟着窗口开关」。 */}
      {showSamples && <SamplesPanel onClose={() => setShowSamples(false)} />}
    </div>
  );
}

function ChipButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="no-drag rounded-xl border border-line-soft bg-ink-850 px-2 py-1 text-[11.5px]
        text-white/60 transition-colors duration-150 hover:border-line hover:bg-ink-800
        hover:text-white disabled:opacity-30"
    >
      {children}
    </button>
  );
}
