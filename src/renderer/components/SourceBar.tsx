import { useMemo, useState } from 'react';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { resolveSources, sourceModeLabel } from '../../shared/sources';
import { audioUiState } from '../../shared/audio-state';
import {
  captureButtonLabel,
  captureButtonAria,
  capturePhase,
  isCaptureActive,
} from '../../shared/capture-state';
import {
  FONT_MAX,
  FONT_MIN,
  FONT_TARGETS,
  adjustFontSize,
  fontSizeOf,
  maxFontSize,
  needsCompactChrome,
  readingPrefs,
  type FontTarget,
} from '../../shared/reading';
import { IconWave } from './icons';

/**
 * 首页顶部的「音源 + 状态 + 读数控制」条。
 *
 * 为什么单独做一条：旧首页把「场景 / 语气 / 快捷动作 / 输入框 / 主按钮」全堆在
 * 底部，而**最重要的两件事**（这台机器现在在听什么、它到底有没有在工作）
 * 反而只挤在标题栏里一行 10.5px 的小字。对靠字幕获取信息的使用者来说，
 * 先要确认「它在听」，才谈得上读字幕。
 *
 * 这一条只放四件事：
 * 1. 当前音源与用途（电脑声音 / 麦克风，以及这个声音是谁在说）；
 * 2. 真实状态（连接中 / 采集中 / 暂未收到声音 / 失败）；
 * 3. 开始 · 暂停 · 重新连接；
 * 4. 字号加减与高对比 —— 阅读相关的调整必须在首页一步可达。
 */
export function SourceBar({
  onToggleListening,
  onReconnect,
}: {
  onToggleListening: () => void;
  onReconnect: () => void;
}) {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const status = useUiStore((state) => state.status);
  const statusMessage = useUiStore((state) => state.statusMessage);
  const busy = useUiStore((state) => state.busy);
  const level = useUiStore((state) => state.level);
  const heardAt = useUiStore((state) => state.heardAt);

  /*
   * 「最近有没有声音」= 8 秒内收到过可闻的采样。
   *
   * 注意不能拿「当前这一帧的 dB」判断：电平包一直在推，安静时是 -120，
   * 上一秒刚响过的那一句会被这一帧的静音覆盖掉，于是状态条在「正在采集」
   * 和「暂未收到声音」之间每秒闪一次。`heardAt` 是界面 store 记下的
   * **最后一次听到声音的时刻**（只在音量高于设备底噪时更新），拿它做滚动
   * 窗口才是稳的，也和主进程那套 8 秒窗口同一个口径。
   */
  const hasSignal = level !== null && Date.now() - heardAt < 8000;
  const ui = useMemo(
    () =>
      audioUiState(status, {
        hasSignal,
        engineAlive: status === 'listening' || status === 'starting' || status === 'no-audio',
        message: statusMessage,
      }),
    [status, hasSignal, statusMessage],
  );

  const plan = resolveSources({
    sourceMode: settings.audio.sourceMode,
    captureSystemAudio: settings.audio.captureSystemAudio,
    captureMicrophone: settings.audio.captureMicrophone,
  });

  const sourceText = plan.items.length
    ? plan.items.map((item) => item.label).join(' + ')
    : '未选择音源';
  /*
   * 「对方音源」而不是「对方在说」。
   *
   * 以前写「对方在说」，但它描述的是**音源归属**（这一路声音是对方那一侧），
   * 不是「现在检测到语音活动」。字幕停顿时用户会以为软件判断错了。
   */
  const spokenBy = plan.items.find((item) => item.translate)?.speaker === 'foreign' ? '对方音源' : '';
  const toneText =
    ui.tone === 'ok'
      ? 'text-ok'
      : ui.tone === 'warn'
        ? 'text-warn'
        : ui.tone === 'danger'
          ? 'text-danger'
          : 'text-white/55';
  const toneDot =
    ui.tone === 'ok'
      ? 'bg-ok'
      : ui.tone === 'warn'
        ? 'bg-warn'
        : ui.tone === 'danger'
          ? 'bg-danger'
          : 'bg-white/30';

  /*
   * 字号：三类文字各有各的值，界面上选「改哪一个」再 A+/A−。
   *
   * 一定要给选择器而不是「只改译文」：要读原文去核对的人、要跟着谐音念的人，
   * 需要的都是不同的那一行。改一类绝不动另外两类。
   */
  const prefs = useMemo(() => readingPrefs(settings.subtitle), [settings.subtitle]);
  const [target, setTarget] = useState<FontTarget>('translation');
  const font = fontSizeOf(prefs, target);
  const targetMeta = FONT_TARGETS.find((item) => item.value === target) ?? FONT_TARGETS[1];

  const setFont = (next: number) => {
    const clamped = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(next)));
    const key =
      target === 'original'
        ? 'originalFontSize'
        : target === 'translation'
          ? 'translationFontSize'
          : 'romanizationFontSize';
    void update({ subtitle: { ...settings.subtitle, [key]: clamped } });
  };

  const stepFont = (delta: number) => {
    const next = adjustFontSize(prefs, target, delta);
    setFont(fontSizeOf(next, target));
  };

  /*
   * 0.6.3：不再自己写一份 running 清单。
   * 以前这里把 no-audio 算「在跑」，按钮显示「暂停」，而 toggleListening
   * 却把 no-audio 当成「没在跑」，点下去反而重新 startListening ——
   * 界面说暂停、实际没停。现在按钮文字、标题栏、快捷键全部只读
   * shared/capture-state.ts 这一个判据。
   */
  const running = isCaptureActive(status);
  const phase = capturePhase(status, running && busy);
  const buttonLabel = captureButtonLabel(status);

  /*
   * 电平读数。
   *
   * 旧首页有一条 20 格的独立电平条，占掉一整行还给不出结论；这里压成 2px
   * 的一条底线：宽度随电平走，能看出「声音真的进来了、而且不小」，又不跟
   * 字幕抢高度。数值同时挂在 data-audio-db 上，自检可以直接读。
   */
  const db = level?.db ?? -120;
  const meterPct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

  return (
    <div
      data-source-bar
      data-audio-db={db.toFixed(0)}
      data-audio-live={hasSignal ? 'true' : 'false'}
      data-capture-phase={phase}
      data-capture-active={running ? 'true' : 'false'}
      className="relative shrink-0 border-b border-line-soft bg-ink-900/70 px-3 py-2.5"
    >
      {/* 音源 + 状态：合成一行，去掉「未开始采集」的重复。 */}
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-soft">
          <IconWave size={13} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p data-source-label className="truncate text-[12px] font-medium text-white/90">
            {sourceText}
            <span className="ml-1 font-normal text-white/45">
              · {sourceModeLabel(settings.audio.sourceMode).replace(/（.*）/, '')}
              {spokenBy ? ` · ${spokenBy}` : ''}
            </span>
          </p>
          <p
            data-audio-status
            data-phase={ui.phase}
            className={`flex min-w-0 items-center gap-1.5 text-[11px] ${toneText}`}
            title={ui.detail}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneDot}`} aria-hidden />
            <span className="truncate">{ui.label}</span>
          </p>
        </div>
      </div>

      {/*
        * 0.6.3 主按钮：占满整行、36px 高，一眼就能点。
        * 旧版把它和字号控件挤在一行，三个入口（标题栏 ▶、卡片「开始监听」、
        * 这里）指向同一动作，用户不知道该点哪个 —— 现在只保留这一个主入口。
        */}
      <button
        type="button"
        data-listen-toggle
        data-capture-action={running ? 'stop' : 'start'}
        onClick={onToggleListening}
        aria-label={captureButtonAria(status)}
        className={`no-drag mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-xl text-[13px]
          font-semibold transition-colors ${
            running
              ? 'border border-danger/45 bg-danger/10 text-danger hover:bg-danger/20'
              : 'bg-accent text-white hover:bg-accent-dim'
          }`}
      >
        {buttonLabel}
        <span className="text-[10px] font-normal opacity-60">Alt + P</span>
      </button>

      {/* 状态说明：一句话讲清「现在为什么是这样、下一步做什么」。 */}
      <p data-audio-detail className="mt-1.5 text-[10px] leading-relaxed text-white/45">
        {ui.detail}
      </p>

      {phase === 'processing' && (
        <p
          data-processing-status
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="mt-0.5 text-[10px] font-medium text-accent-soft"
        >
          采集中 · 正在处理上一句（不会自动停止采集）
        </p>
      )}

      {/* 重新连接：只在失败/掉线时出现，不再常驻。 */}
      {ui.showReconnect && (
        <button
          type="button"
          data-reconnect
          onClick={onReconnect}
          aria-label="重新连接音频设备"
          className="no-drag mt-1.5 w-full rounded-lg border border-warn/40 bg-warn/10 py-1.5
            text-[11px] font-semibold text-warn transition-colors hover:bg-warn/20"
        >
          重新连接音频设备
        </button>
      )}

      {/*
        * 字号控件独立成一行，点击目标加大到 32px（A-/A+）。
        * 旧版 A-/A+ 只有 24px 且和三个字号目标、高对比挤同一行，
        * 手指/鼠标都难点。现在「改哪个」和「改多少」分两段排。
        */}
      <div className="mt-2 flex items-center gap-2">
        <div
          role="group"
          aria-label="选择要调整字号的文字"
          data-font-target-group
          className="flex flex-1 items-center gap-0.5 rounded-lg border border-line-soft bg-ink-850 p-0.5"
        >
          {FONT_TARGETS.map((option) => {
            const active = option.value === target;
            return (
              <button
                key={option.value}
                type="button"
                data-font-target={option.value}
                aria-pressed={active}
                aria-label={`调整${option.label}`}
                title={option.hint}
                onClick={() => setTarget(option.value)}
                className={`no-drag flex-1 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors ${
                  active ? 'bg-accent/25 text-white' : 'text-white/50 hover:text-white/80'
                }`}
              >
                {option.short}
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-font-dec
            onClick={() => stepFont(-1)}
            disabled={font <= FONT_MIN}
            aria-label={`缩小${targetMeta.label}，当前 ${font} 像素`}
            className="no-drag grid h-8 w-8 place-items-center rounded-lg border border-line
              bg-ink-850 text-[15px] font-semibold text-white/80 transition-colors hover:bg-ink-800
              disabled:opacity-30"
          >
            A−
          </button>
          <span
            data-font-value={font}
            aria-live="polite"
            className="tnum w-7 shrink-0 text-center text-[11px] text-white/60"
          >
            {font}
          </span>
          <button
            type="button"
            data-font-inc
            onClick={() => stepFont(1)}
            disabled={font >= FONT_MAX}
            aria-label={`放大${targetMeta.label}，当前 ${font} 像素`}
            className="no-drag grid h-8 w-8 place-items-center rounded-lg border border-line
              bg-ink-850 text-[15px] font-semibold text-white/80 transition-colors hover:bg-ink-800
              disabled:opacity-30"
          >
            A+
          </button>
          <button
            type="button"
            data-contrast-toggle
            aria-pressed={settings.subtitle.highContrast}
            aria-label="高对比显示"
            title="高对比显示（黑白高反差，弱视更清楚）"
            onClick={() =>
              void update({
                subtitle: { ...settings.subtitle, highContrast: !settings.subtitle.highContrast },
              })
            }
            className={`no-drag ml-1 grid h-8 place-items-center rounded-lg border px-2 text-[11px]
              font-medium transition-colors ${
                settings.subtitle.highContrast
                  ? 'border-accent/50 bg-accent/20 text-accent-soft'
                  : 'border-line bg-ink-850 text-white/60 hover:bg-ink-800 hover:text-white/85'
              }`}
          >
            高对比
          </button>
        </div>
      </div>

      {needsCompactChrome(maxFontSize(prefs)) && (
        <span data-compact-chrome className="mt-1 block text-[9.5px] text-white/35">
          大字模式：底部按钮已精简
        </span>
      )}

      {/* 2px 电平线：纯装饰性反馈，读屏不念（aria-hidden），结论看上面的状态文字。 */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-ink-800">
        <span
          className="block h-full bg-ok/70 transition-[width] duration-100 ease-out"
          style={{ width: `${running ? meterPct : 0}%` }}
        />
      </span>
    </div>
  );
}
