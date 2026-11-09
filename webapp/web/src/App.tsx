import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SAMPLE_CASES } from '@shared/samples';
import { useApp } from './state';
import {
  detectCapabilities,
  describeMicError,
  hasVoiceFor,
  speak,
  startRecording,
  stopSpeaking,
  type Capabilities,
  type MicError,
  type RecorderHandle,
} from './adapter/browser';
import { toWav } from './adapter/wav';
import { hintsFor, needsWording } from './lib/pipeline';
import { SOURCE_LANGUAGES, modeLabel, type Health, type SourceLanguage } from './api';
import { toChineseSpeech, type NumericCheck } from '@shared/numeric-check';
import type { TargetLanguage } from '@shared/types';
import type { PlannedReply } from '@shared/reply-plan';
import { REPLY_SOURCE_NOTE, REPLY_MODEL_HINT } from '@shared/reply-plan';
import { ReplyCards } from './ReplyCards';
import { FeedbackPanel, type FeedbackContext } from './FeedbackPanel';
import { TabAudioPanel } from './TabAudioPanel';
import {
  applyTheme,
  readThemePref,
  saveThemePref,
  systemPrefersDark,
  THEME_OPTIONS,
  watchSystemTheme,
  type ThemeName,
  type ThemePref,
} from './theme';

/** 主导航四项。学习页在 P3 才做，这一版明确标「未实现」，不放假按钮。 */
type Tab = 'captions' | 'learn' | 'feedback' | 'settings';
const TABS: { value: Tab; label: string }[] = [
  { value: 'captions', label: '字幕' },
  { value: 'learn', label: '学习' },
  { value: 'feedback', label: '反馈' },
  { value: 'settings', label: '设置' },
];

/** 源语言 → 读音提示用的语言名（读音规则按原文语言走，不按界面语言走）。 */
const HINT_TARGET: Record<SourceLanguage, TargetLanguage> = {
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
};

const ZH_EN_SAMPLES = SAMPLE_CASES.map((sample) => {
  const variant = sample.variants['zh-en'];
  return variant ? { id: sample.id, title: sample.title, ...variant } : null;
}).filter((item): item is NonNullable<typeof item> => Boolean(item));

type MicState = 'idle' | 'recording' | 'processing';

function Badge({
  tone,
  children,
}: {
  tone: 'real' | 'preset' | 'warn' | 'muted' | 'table';
  children: ReactNode;
}) {
  const map = {
    real: 'border-ok/40 bg-ok/10 text-ok',
    preset: 'border-warn/40 bg-warn/10 text-warn',
    warn: 'border-danger/40 bg-danger/10 text-danger',
    muted: 'border-white/12 bg-white/5 text-white/60',
    // 常用语库：既不是模型，也不是演示预置，用中性色单独区分。
    table: 'border-white/25 bg-white/8 text-white/75',
  } as const;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${map[tone]}`}>
      {children}
    </span>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="surface mt-4 rounded-2xl border border-white/10 bg-ink-900/70 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-white/85">{title}</h2>
        {hint ? <span className="muted text-[11px] text-white/45">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function App() {
  const state = useApp();
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [englishVoice, setEnglishVoice] = useState(false);
  const [micState, setMicState] = useState<MicState>('idle');
  const [micError, setMicError] = useState<MicError | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [originalFont, setOriginalFont] = useState(24);
  const [translationFont, setTranslationFont] = useState(28);
  const [highContrast, setHighContrast] = useState(false);
  const [tab, setTab] = useState<Tab>('captions');
  const [themePref, setThemePref] = useState<ThemePref>(() => readThemePref());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [themeName, setThemeName] = useState<ThemeName>('dark');
  const [reduceMotion, setReduceMotion] = useState(false);
  const [feedbackContext, setFeedbackContext] = useState<FeedbackContext | null>(null);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showCard, setShowCard] = useState(false);
  /**
   * 大字卡要显示哪一句。
   * null = 用「确认句」（state.plan）；非 null = 用户点了某条回复建议的「放大给对方看」。
   * 没有这个，回复卡上的放大按钮就只能放大确认句 —— 点哪条都一样，等于坏的。
   */
  const [cardSentence, setCardSentence] = useState<{ sentence: string; meaning: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [wording, setWording] = useState<{ id: string; value: string } | null>(null);
  const recorder = useRef<RecorderHandle | null>(null);
  /**
   * 大字卡关闭后要把焦点还给**本次点开的那一颗按钮**。
   *
   * 旧写法是把它当 `ref` 挂在唯一一颗「放大给对方看」上。回复卡的三颗
   * 放大按钮没有绑定，于是从那儿打开再关掉，ref 是 null，焦点就掉回
   * BODY —— 键盘用户得从头 Tab 一遍。现在改成**打开时记元素**，
   * 所有入口共用，Escape 和「关闭」按钮都走同一条关闭路径。
   */
  const cardTrigger = useRef<HTMLElement | null>(null);
  const openBigCard = useCallback(
    (sentence: string, meaning: string, trigger: HTMLElement | null) => {
      cardTrigger.current = trigger ?? (document.activeElement as HTMLElement | null);
      setCardSentence({ sentence, meaning });
      setShowCard(true);
    },
    [],
  );

  useEffect(() => {
    setCaps(detectCapabilities());
    void state.init();
    // 只在首次挂载时拉健康检查与会话，避免 StrictMode 下重复建会话。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 页面被隐藏或关闭时立刻停掉麦克风，不把采集留在后台。
  useEffect(() => {
    const stop = () => {
      recorder.current?.cancel();
      recorder.current = null;
    };
    window.addEventListener('pagehide', stop);
    window.addEventListener('beforeunload', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      window.removeEventListener('beforeunload', stop);
      stop();
    };
  }, []);

  /*
   * 语音列表是异步的：Chrome 首帧常返回空数组，直接判断会误报「没有英语语音」。
   * 单独一个 effect，监听 voiceschanged 后再判一次。
   */
  useEffect(() => {
    const syncVoices = () => setEnglishVoice(hasVoiceFor('en-US'));
    syncVoices();
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.addEventListener('voiceschanged', syncVoices);
    return () => speechSynthesis.removeEventListener('voiceschanged', syncVoices);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('hc', highContrast);
  }, [highContrast]);

  /*
   * 主题只写 body 的属性，不重挂载任何组件 —— 切换时字幕、事实卡、
   * 回复卡和输入框里的字都还在。跟随系统时订阅系统偏好变化。
   */
  useEffect(() => {
    saveThemePref(themePref);
    /*
     * 点「跟随系统」的那一刻必须**重新读**系统真实偏好。
     *
     * `systemDark` 是挂载时的快照：如果用户系统本来就是深色、之后一直没变，
     * 中途切到「跟随系统」时快照还是浅色，change 事件永远不来 —— 界面会
     * 一直停在白色模式。这是真 Chrome 验收里抓到的，靠订阅补不上第一次。
     */
    const dark = themePref === 'system' ? systemPrefersDark() : systemDark;
    setThemeName(applyTheme(themePref, dark));
  }, [themePref, systemDark]);
  useEffect(() => {
    if (themePref !== 'system') return;
    /*
     * 订阅建立的那一刻先把快照校准到系统**当前**的偏好。
     *
     * 不校准会漏一次：系统在「非跟随」期间变成深色，这时没人订阅；
     * 切到「跟随」后界面靠 `systemPrefersDark()` 直接读对了深色，但
     * `systemDark` 这个 state 还是旧的 false。等系统切回浅色时，
     * change 事件带来 false —— 和旧快照相同，React 跳过重渲染，
     * 界面就一直卡在深色。真 Chrome 验收里抓到过。
     */
    setSystemDark(systemPrefersDark());
    return watchSystemTheme(setSystemDark);
  }, [themePref]);
  useEffect(() => {
    document.body.classList.toggle('reduce-motion', reduceMotion);
  }, [reduceMotion]);

  const health = state.health;
  const modeBadges = useMemo(() => {
    if (state.healthError) {
      return <Badge tone="warn">服务端不可达：{state.healthError}</Badge>;
    }
    if (!health) return <Badge tone="muted">正在连接服务端…</Badge>;
    return (
      <>
        <Badge tone={health.real.translate ? 'real' : 'warn'}>
          翻译：{modeLabel(health.mode.translate)}
        </Badge>
        <Badge tone={health.real.transcribe ? 'real' : 'warn'}>
          识别：{modeLabel(health.mode.transcribe)}
        </Badge>
      </>
    );
  }, [health, state.healthError]);

  const pickSample = useCallback(
    (sample: (typeof ZH_EN_SAMPLES)[number]) => {
      void state.translate(sample.original, 'preset', sample.translation);
    },
    [state],
  );

  const beginRecording = useCallback(async () => {
    setMicError(null);
    try {
      recorder.current = await startRecording();
      setMicState('recording');
    } catch (error) {
      setMicState('idle');
      setMicError(describeMicError(error));
    }
  }, []);

  const endRecording = useCallback(async () => {
    const handle = recorder.current;
    if (!handle) return;
    setMicState('processing');
    try {
      const blob = await handle.stop();
      recorder.current = null;
      setMicState('idle');
      if (blob.size < 1200) {
        setFileNotice('这段录音几乎是空的（太短或没收到声音），再说一遍试试。');
        return;
      }
      setFileNotice(null);
      // 浏览器先解成 16k 单声道 WAV：服务端不需要 ffmpeg 也能读。
      const wav = await toWav(blob);
      await state.transcribe(wav.blob, 'clip.wav');
    } catch (error) {
      recorder.current = null;
      setMicState('idle');
      setFileNotice(error instanceof Error ? error.message : '录音处理失败');
    }
  }, [state]);

  const onFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      const maxMb = health?.limits.max_audio_mb ?? 8;
      if (file.size > maxMb * 1024 * 1024) {
        setFileNotice(`文件超过 ${maxMb}MB 上限，截短一点再传。`);
        return;
      }
      setFileNotice(null);
      setMicState('processing');
      try {
        await state.transcribe(file, file.name);
      } finally {
        setMicState('idle');
      }
    },
    [health, state],
  );

  const stageText =
    state.stage === 'translating'
      ? '正在翻译…'
      : state.stage === 'transcribing'
        ? '正在识别录音…'
        : state.stage === 'replying'
          ? '正在生成回复建议…'
          : '';

  const sourceBadge =
    state.translateMode === 'preset' ? (
      <Badge tone="preset">预置演示 · 不是模型输出</Badge>
    ) : state.translateMode === 'phrasebook' ? (
      <Badge tone="table">常用语库 · 人工整理，不是模型</Badge>
    ) : state.translateMode ? (
      <Badge tone={state.translateMode === 'mock' ? 'warn' : 'real'}>{modeLabel(state.translateMode)}</Badge>
    ) : null;

  const sttBadge =
    state.transcribeMode === 'mock' ? <Badge tone="warn">识别：预置结果</Badge> : null;

  const hints = useMemo(
    () =>
      state.original && state.translateMode !== 'preset'
        ? hintsFor(state.original, HINT_TARGET[state.sourceLang])
        : null,
    [state.original, state.translateMode, state.sourceLang],
  );

  const currentLang =
    SOURCE_LANGUAGES.find((item) => item.code === state.sourceLang) ?? SOURCE_LANGUAGES[0];

  // 归还焦点统一由弹层卸载时的 restoreFocus 负责（Escape 和「关闭」都走这里），
  // 不再在这里手动 focus 一次，免得两条路径互相清空锚点。
  const closeCard = useCallback(() => setShowCard(false), []);

  // 隐私弹层的触发按钮：关闭后焦点回到这里，键盘用户不会掉回页首。
  const privacyTrigger = useRef<HTMLButtonElement | null>(null);
  const closePrivacy = useCallback(() => {
    setShowPrivacy(false);
    privacyTrigger.current?.focus();
  }, []);

  return (
    <div data-app-shell className="mx-auto min-h-screen w-full max-w-3xl px-4 pb-24 pt-4">
      <nav aria-label="主导航" className="mb-3 flex flex-wrap gap-1.5" data-testid="main-nav">
        {TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-current={tab === item.value ? 'page' : undefined}
            aria-label={`主导航：${item.label}`}
            data-testid={`nav-${item.value}`}
            onClick={() => setTab(item.value)}
            className={`rounded-xl px-3.5 py-2 text-[13px] ${
              tab === item.value
                ? 'bg-accent/30 text-white ring-1 ring-accent'
                : 'border border-white/12 text-white/75'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <header className="surface rounded-2xl border border-white/10 bg-ink-900/80 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 tabIndex={-1} data-focus-fallback className="text-lg font-semibold text-white outline-none">
              英语沟通字幕助手
            </h1>
            <p className="muted mt-1 text-[12.5px] text-white/55">
              看清对方说的英语 → 核对时间、金额和否定 → 说一句确认。网页版，免注册。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">{modeBadges}</div>
        </div>
        <p className="mt-2 text-[11.5px] text-white/45" data-testid="header-status">
          当前主题：{THEME_OPTIONS.find((option) => option.value === themePref)?.label ?? '跟随系统'}
          （{themeName === 'dark' ? '深夜' : themeName === 'warm' ? '护眼暖色' : '白色'}）
          {' · '}字号、对比度、模型详情和诊断信息在「设置」里。
        </p>
      </header>
      <div hidden={tab !== 'captions'}>

      <Section title="1 · 对方说的话" hint="先说清是哪种语言，再打字、录音，或点一条预置样例">
        {/*
          语言选择。用按钮组而不是 <select>：
          1) 项目规范里禁原生 select（自绘才控得住配色与焦点环）；
          2) 每个语种要能表达「就绪 / 未就绪」两种状态，原生选项做不到。
          未就绪的语种**禁用**并写明原因 —— 让人点了才发现翻不了，是最差的体验。
        */}
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="对方说的语言"
          data-testid="source-language-group"
        >
          {SOURCE_LANGUAGES.map((item) => {
            const remote = state.health?.languages?.source?.[item.code];
            const ready = item.code === 'en' ? true : Boolean(remote?.ready);
            const active = state.sourceLang === item.code;
            return (
              <button
                key={item.code}
                type="button"
                aria-pressed={active}
                disabled={!ready || state.stage !== 'idle'}
                data-testid={`source-language-${item.code}`}
                title={ready ? `对方说${item.label}` : `${item.label}翻译模型还没装好，暂时不能翻`}
                className={`rounded-lg border px-2.5 py-1 text-[12px] disabled:opacity-40 ${
                  active
                    ? 'border-accent/70 bg-accent/15 text-accent-soft'
                    : 'border-white/12 text-white/70'
                }`}
                onClick={() => state.setSourceLang(item.code)}
              >
                {item.label}
                {ready ? null : <span className="ml-1 text-[10px] text-white/45">未就绪</span>}
              </button>
            );
          })}
        </div>
        <label className="muted mt-2 block text-[12px] text-white/55" htmlFor="original-input">
          原文（{currentLang.label}）
        </label>
        <textarea
          id="original-input"
          data-testid="original-input"
          className="mt-1.5 min-h-[92px] w-full resize-y rounded-xl border border-white/12 bg-ink-950/70 p-3 text-[15px] leading-relaxed text-white outline-none focus-visible:border-accent"
          placeholder={`例如：${currentLang.sample}`}
          value={state.original}
          onChange={(event) => state.setOriginal(event.target.value)}
          spellCheck={false}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="translate"
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-ink-950 disabled:opacity-40"
            disabled={!state.original.trim() || state.stage !== 'idle' || state.sessionState !== 'ready'}
            onClick={() => void state.translate(state.original, 'text')}
          >
            翻译成中文
          </button>
          {micState === 'idle' ? (
            <button
              type="button"
              data-testid="mic-start"
              className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/85"
              disabled={caps?.mic !== 'ok' || state.sessionState !== 'ready'}
              onClick={() => void beginRecording()}
            >
              开始录音
            </button>
          ) : (
            <button
              type="button"
              data-testid="mic-stop"
              className="rounded-xl border border-danger/60 bg-danger/10 px-3 py-2 text-sm text-danger"
              disabled={micState === 'processing'}
              onClick={() => void endRecording()}
            >
              {micState === 'processing' ? '处理中…' : '停止并识别'}
            </button>
          )}
          <label className="cursor-pointer rounded-xl border border-white/15 px-3 py-2 text-sm text-white/85">
            上传音频
            <input
              type="file"
              accept="audio/*"
              className="sr-only"
              data-testid="audio-file"
              disabled={state.sessionState !== 'ready'}
              onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        {/* 会话没准备好时，真实调用必须先不可提交：健康徽标只说明进程活着，
            不能说明这一趟请求带得回服务端认识的会话。 */}
        {state.sessionState === 'pending' ? (
          <p className="muted mt-2 text-[11.5px] text-white/50" data-testid="session-pending" role="status">
            正在建立匿名会话，稍等一下就能提交（预置样例不受影响）。
          </p>
        ) : null}
        {state.sessionState === 'failed' ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-warn" role="alert">
            <span data-testid="session-failed">
              没能建立匿名会话：{state.sessionError ?? '未知原因'}。真实调用暂时不可用，预置样例仍可点。
            </span>
            <button
              type="button"
              data-testid="session-retry"
              className="rounded-lg border border-warn/50 px-2 py-0.5 text-[11.5px] text-warn"
              onClick={() => void state.retrySession()}
            >
              重新建立会话
            </button>
          </p>
        ) : null}

        <div className="mt-2 space-y-1 text-[11.5px]">
          {caps?.mic === 'insecure' ? (
            <p className="text-warn">
              当前不是 HTTPS，浏览器不会给麦克风权限。文字输入与音频文件不受影响。
            </p>
          ) : null}
          {caps?.mic === 'unsupported' ? (
            <p className="text-warn">这个浏览器没有麦克风接口，请用文字输入或音频文件。</p>
          ) : null}
          {micError ? <p className="text-danger">{micError.message}</p> : null}
          {fileNotice ? <p className="text-warn">{fileNotice}</p> : null}
          {micState === 'recording' ? (
            <p className="text-danger" role="status">
              ● 正在采集麦克风（只在这个浏览器里，停止后立刻释放）
            </p>
          ) : null}
          {caps && caps.speech.available && !englishVoice ? (
            <p className="muted text-white/45">这台设备没有英语语音包，网页朗读会不可用（可以看大字卡）。</p>
          ) : null}
        </div>

        {/*
          预置样例只有英语三组。切到日/韩/俄就不显示 —— 让「日语」标签下面躺着
          三条英文样例，等于告诉使用者「语言选择没生效」，比不显示更糟。
        */}
        {state.sourceLang === 'en' ? (
          <div className="mt-3 border-t border-white/8 pt-3">
            <p className="muted mb-2 text-[11.5px] text-white/45">
              三组预置样例（<span className="text-warn">预置演示</span>，不代表真实翻译质量）
            </p>
            <div className="flex flex-col gap-2">
              {ZH_EN_SAMPLES.map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  data-testid={`sample-${sample.id}`}
                  className="rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-left text-[13px] text-white/80 hover:border-accent/50"
                  onClick={() => pickSample(sample)}
                >
                  <span className="font-medium text-white/90">{sample.title}</span>
                  <span className="muted mt-0.5 block text-[11.5px] text-white/50">{sample.original}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="muted mt-3 border-t border-white/8 pt-3 text-[11.5px] text-white/45">
            {currentLang.label}没有预置样例，直接在上面粘贴或输入原文即可。
          </p>
        )}
      </Section>

      <div aria-live="polite" className="mt-2 min-h-[20px] text-[12px] text-white/60">
        {state.notice?.kind === 'error' ? <span className="text-danger">{state.notice.text}</span> : null}
        {state.notice?.kind === 'error' && state.original.trim() && state.stage === 'idle' ? (
          <button
            type="button"
            data-testid="retry-last"
            className="ml-2 rounded-lg border border-white/25 px-2 py-0.5 text-[11.5px] text-white/80"
            onClick={() => void state.translate(state.original, 'text')}
          >
            重试一次
          </button>
        ) : null}
        {state.notice?.kind === 'warn' ? <span className="text-warn">{state.notice.text}</span> : null}
        {!state.notice && stageText ? <span>{stageText}</span> : null}
        {!state.notice && !stageText && state.translateMode && state.translateMode !== 'preset' ? (
          <span>
            {/*
              常用语库是查表直出，不是「翻译完成」，更没有耗时可言（实测 0.00s，
              看起来像模型瞬间翻完，其实是没跑模型）。这一行必须说实话。
            */}
            {state.translateMode === 'phrasebook'
              ? '常用语库直接命中 · 没有调用模型'
              : `翻译完成 · ${state.elapsedMs != null ? `${(state.elapsedMs / 1000).toFixed(2)}s` : '耗时未返回'}`}
            {state.requestId ? ` · 请求 ${state.requestId.slice(0, 8)}` : ''}
          </span>
        ) : null}
      </div>

      {state.original && (state.translation || state.translateMode === 'preset') ? (
        <Section title="2 · 字幕" hint="原文在上，中文在下；顶部 A− / A+ 一起调两行">
          <div className="flex flex-wrap items-center gap-2">
            {sourceBadge}
            {sttBadge}
          </div>
          {/* 「配了真实后端」和「真的调通了」是两件事：错 Key 时前者仍为真。 */}
          {state.health?.real.translate && state.health?.verified?.translate === false && state.translateMode !== 'preset' ? (
            <p className="muted mt-1 text-[11px] text-white/45" data-testid="unverified-hint">
              服务端已配置翻译模型，但这一页还没成功调通过；下面这条结果如果出来了，说明已经通了。
            </p>
          ) : null}
          {/*
            常用语库的两条说明。都是「这条结果是怎么来的」，不是装饰：
            - 手误纠正：必须说我按哪个词查的，否则用户不知道 hellow 为什么变成「你好」；
            - 单词词义：一个词的释义不是一句话的翻译，不能让人以为对方说的是「你好；喂」。
          */}
          {state.translateMode === 'phrasebook' && state.translateCorrected && state.translateMatched ? (
            <p className="muted mt-1 text-[11px] text-white/50" data-testid="corrected-hint">
              你打的是一个常见手误，这条按「{state.translateMatched}」查的；上面的原文没有改动。
            </p>
          ) : null}
          {state.translateMode === 'phrasebook' && state.translateNote === 'word' ? (
            <p className="muted mt-1 text-[11px] text-white/50" data-testid="word-gloss-hint">
              这是这个单词的常用词义，不是整句翻译。
            </p>
          ) : null}
          {/*
            两级转译必须说明。日/韩/俄没有直译中文的模型，这句是经英语中转的，
            措辞会比英译中粗糙 —— 不说清楚，用户会把「两跳的误差」当成翻译质量问题。
            中间那句英语也留着：既方便对照，也方便我们定位是哪一级出的错。
          */}
          {state.translateMode === 'local-cascade' ? (
            <div className="mt-1.5 rounded-xl border border-white/10 bg-white/4 px-2.5 py-2" data-testid="cascade-hint">
              <p className="text-[11px] leading-relaxed text-white/55">
                {currentLang.label}这一版没有「直译中文」的模型，这句是
                <span className="text-white/80">「{currentLang.label} → 英语 → 中文」</span>
                两级转译，措辞可能比英译中粗糙。
              </p>
              {state.translateVia ? (
                <p className="mt-1 break-words text-[11px] text-white/40">
                  中间的英语：{state.translateVia}
                </p>
              ) : null}
            </div>
          ) : null}
          <p
            className="mt-2 whitespace-pre-wrap font-medium leading-snug text-white"
            style={{ fontSize: originalFont }}
            data-testid="original-text"
          >
            {state.original}
          </p>
          <p
            className="mt-2 whitespace-pre-wrap leading-snug text-accent-soft"
            style={{ fontSize: translationFont }}
            data-testid="translation-text"
          >
            <TranslationText text={state.translation} check={state.numericCheck} />
          </p>
          <NumericWarning check={state.numericCheck} />
          {/* 每条字幕旁边都要能报「翻译有误」，并且带上这句原文与译文供预览。 */}
          <button
            type="button"
            data-testid="feedback-from-caption"
            aria-label="这句翻译有误，去反馈"
            onClick={() => {
              setFeedbackContext({ original: state.original, translation: state.translation });
              setTab('feedback');
            }}
            className="mt-2 rounded-lg border border-white/15 px-2.5 py-1 text-[11.5px] text-white/75"
          >
            翻译有误 / 反馈
          </button>
          {/*
            模型对译文做过的修正要**说出来**。
            「300美元」被剪成「300」如果不说，用户会以为模型本来就这么翻；
            说清楚之后，他知道对方没提币种，核对时才会去问。
          */}
          {state.translateCorrections.length ? (
            <ul className="mt-2 space-y-1" data-testid="translate-corrections">
              {state.translateCorrections.map((code) => (
                <li key={code} className="rounded-lg border border-warn/30 bg-warn/8 px-2 py-1 text-[11.5px] text-warn">
                  {code === 'currency-removed'
                    ? '译文里的币种已去掉：原话没有说明币种，模型自己补的不能算数'
                    : code === 'reschedule-restored'
                      ? '译文已补回「改到」：原话明确说了改期，只写「从…到…」会看不出哪个才有效'
                      : `已修正：${code}`}
                </li>
              ))}
            </ul>
          ) : null}
          {hints && hints.text ? (
            <p className="muted mt-2 break-words text-[13px] leading-relaxed text-white/45">
              <span className="text-white/35">汉字近音（规则近似，不是标准音标）：</span>
              {hints.text}
            </p>
          ) : null}
        </Section>
      ) : null}

      {state.facts.length ? (
        <Section title="3 · 重点信息" hint="勾上要核对的，再生成一句确认">
          <ul className="space-y-2">
            {state.facts.map((fact) => (
              <li
                key={fact.id}
                id={`fact-row-${fact.id}`}
                className="rounded-xl border border-white/10 bg-white/4 p-3"
                data-testid="fact-row"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-white/70">
                    {fact.label}
                  </span>
                  <span
                    className={`text-[14px] font-medium ${
                      fact.negated ? 'text-white/40 line-through' : 'text-white'
                    }`}
                  >
                    {fact.value}
                  </span>
                  <ChineseReading value={fact.value} />
                  {/*
                    币种没说是**原话没说**，不是「默认美元」。
                    `The deposit is 300` 的译文实测会补成「300美元」——
                    补出来的币种一旦被当原话，用户核对时就等于替对方编了一个。
                  */}
                  {fact.kind === 'money' && !fact.currency ? (
                    <Badge tone="warn">币种未说明</Badge>
                  ) : null}
                  {fact.role === 'origin' ? <Badge tone="warn">原安排，已改</Badge> : null}
                  {fact.role === 'current' ? <Badge tone="real">现安排</Badge> : null}
                  {fact.role === 'duration' ? <Badge tone="muted">时长</Badge> : null}
                  {fact.negated ? <Badge tone="warn">被对方否定，不作数</Badge> : null}
                  {fact.edited ? <Badge tone="real">已由你改成「{fact.value}」</Badge> : null}
                  {needsWording(fact) ? <Badge tone="warn">需补说法</Badge> : null}
                  {/*
                    来源必须说准。旧版这里一律写「原话：」，
                    而译文中提出来的值（模型补的「300美元」）也被标成原话 ——
                    用户看到的是「原话：300美元」，对方根本没说币种。
                  */}
                  <span
                    id={`fact-src-${fact.id}`}
                    className="muted text-[11.5px] text-white/40"
                  >
                    {fact.sourceField === 'translation' ? '译文中：' : '原话：'}
                    {fact.sourceText}
                  </span>
                </div>
                {editing?.id === fact.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      className="min-w-[160px] flex-1 rounded-lg border border-white/15 bg-ink-950/80 px-2 py-1 text-[13px] text-white"
                      value={editing.value}
                      data-testid="fact-edit-input"
                      onChange={(event) => setEditing({ id: fact.id, value: event.target.value })}
                      aria-label={`修改${fact.label}`}
                    />
                    <button
                      type="button"
                      className="rounded-lg bg-accent px-2.5 py-1 text-[12px] text-ink-950"
                      data-testid="fact-edit-save"
                      onClick={() => {
                        state.editFact(fact.id, editing.value);
                        setEditing(null);
                      }}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/75"
                      onClick={() => setEditing(null)}
                    >
                      取消
                    </button>
                  </div>
                ) : null}
                {wording?.id === fact.id ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      className="min-w-[160px] flex-1 rounded-lg border border-white/15 bg-ink-950/80 px-2 py-1 text-[13px] text-white"
                      value={wording.value}
                      placeholder="用英语写出这条现在该怎么说"
                      data-testid="fact-spoken-input"
                      onChange={(event) => setWording({ id: fact.id, value: event.target.value })}
                      aria-label={`为${fact.label}补英语说法`}
                    />
                    <button
                      type="button"
                      className="rounded-lg bg-accent px-2.5 py-1 text-[12px] text-ink-950"
                      data-testid="fact-spoken-save"
                      onClick={() => {
                        state.speakFact(fact.id, wording.value);
                        setWording(null);
                      }}
                    >
                      保存说法
                    </button>
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {/*
                    每条事实的操作必须能区分。
                    实测上一版每行都叫「核对这条 / 修改 / 改说法」，
                    读屏连续读下来完全分不清在操作哪一条 —— 而这张卡上
                    通常同时有金额、时间、日期三行。
                  */}
                  <label className="flex items-center gap-1.5 text-[12px] text-white/70">
                    <input
                      type="checkbox"
                      checked={fact.checked}
                      onChange={() => state.toggleFact(fact.id)}
                      data-testid="fact-check"
                      aria-label={`核对${fact.label} ${fact.value}${
                        fact.negated ? '（这一条已被对方否定）' : ''
                      }`}
                      aria-describedby={`fact-src-${fact.id}`}
                    />
                    核对{fact.label}
                  </label>
                  <button
                    type="button"
                    className="rounded-lg border border-white/12 px-2 py-0.5 text-[12px] text-white/70"
                    onClick={() => setEditing({ id: fact.id, value: fact.value })}
                    aria-label={`修改${fact.label} ${fact.value}`}
                    data-testid="fact-edit"
                  >
                    修改{fact.label}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/12 px-2 py-0.5 text-[12px] text-white/70"
                    onClick={() => setWording({ id: fact.id, value: fact.spoken ?? '' })}
                    aria-label={`为${fact.label} ${fact.value} 补一句英语说法`}
                  >
                    改说法
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="confirm-build"
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-ink-950"
              onClick={() => state.buildConfirm()}
            >
              帮我确认
            </button>
            <button
              type="button"
              data-testid="ask-reply"
              className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/85"
              onClick={() => void state.askReply()}
            >
              {state.replies.length ? '再给我几条回复建议' : '给我一句回复建议'}
            </button>
          </div>

          {state.plan ? (
            state.plan.ok ? (
              <div className="mt-3 rounded-xl border border-ok/30 bg-ok/8 p-3" data-testid="confirm-card">
                <p className="text-[11.5px] text-ok">给对方看的一句确认（英语）</p>
                <p className="mt-1 text-[19px] font-medium leading-snug text-white" data-testid="confirm-english">
                  {state.plan.sentence}
                </p>
                <p className="mt-2 text-[12.5px] text-white/70" data-testid="confirm-meaning">
                  {state.plan.meaning}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="show-card"
                    className="rounded-lg bg-white/10 px-3 py-1.5 text-[12px] text-white"
                    onClick={(event) =>
                      openBigCard(
                        state.plan?.sentence ?? '',
                        state.plan?.meaning ?? '',
                        event.currentTarget,
                      )
                    }
                  >
                    放大给对方看
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/15 px-3 py-1.5 text-[12px] text-white/80"
                    onClick={() => {
                      const result = speak(state.plan?.sentence ?? '', 'en-US');
                      if (!result.ok && result.reason) setFileNotice(result.reason);
                    }}
                  >
                    朗读（需设备有英语语音）
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-3 rounded-xl border border-warn/30 bg-warn/8 p-3 text-[12.5px] text-warn" data-testid="confirm-blocked">
                {state.plan.message}
              </p>
            )
          ) : null}
        </Section>
      ) : null}

      {/*
        回复卡必须放在「重点信息」区块**外面**：hellow 这种问候没有可核对的
        事实，facts 为空，区块不渲染 —— 回复也就跟着消失了（线上实测过）。

        卡片内容由本地的 `planReplies()` 按当前事实或内容场景拼，翻译成功即生成，
        不依赖模型与网络；服务端真有模型时才换成 AI 建议并另行标注。
      */}
      {state.replyCards.length ? (
        <ReplyCards
          cards={state.replyCards}
          sourceNote={
            state.replyMode && state.replyMode !== 'mock'
              ? REPLY_SOURCE_NOTE.model
              : REPLY_SOURCE_NOTE.rule
          }
          onSpeak={(text, rate) => {
            const result = speak(text, 'en-US', {
              rate,
              onError: (reason) => setFileNotice(reason),
            });
            if (!result.ok && result.reason) setFileNotice(result.reason);
          }}
          onStop={() => stopSpeaking()}
          onEdit={(id, en) => state.editReply(id, en)}
          onShowBig={(card: PlannedReply, trigger) => openBigCard(card.en, card.zh, trigger)}
          onFeedback={(card: PlannedReply) => {
            setFeedbackContext({
              original: state.original,
              translation: state.translation,
              reply: card.en,
            });
            setTab('feedback');
          }}
        />
      ) : null}
      {state.replyCards.length ? (
        <details className="mt-2 text-[11.5px] text-white/55" data-testid="reply-model-hint">
          <summary className="cursor-pointer text-white/70">
            这些回复是 AI 生成的吗？怎么开启真 AI？
          </summary>
          <p className="mt-1.5 rounded-xl border border-white/10 bg-white/4 px-3 py-2 leading-relaxed">
            {REPLY_MODEL_HINT}
          </p>
        </details>
      ) : null}

      {/* P2：授权标签页音频捕获。放在主流程之后，不挤占「看懂→核对→回复」。 */}
      <TabAudioPanel />

      <footer className="mt-6 text-[11.5px] leading-relaxed text-white/40">
        <p>
          字幕、录音和会话只在服务端内存里处理，重启即清；反馈单独写进数据库（见「反馈」）。
          模型与接收方见「设置—隐私与数据」。
        </p>
        <p className="mt-1">
          重点信息由规则提取，可能与原话有出入；确认句请当面再核一遍。网页不做 Windows 系统声音采集，
          那条链路由桌面客户端负责；网页的「翻译其他网页视频」只在你主动授权的标签页音频上工作。
        </p>
        <button
          type="button"
          data-testid="feedback-general"
          aria-label="普通意见反馈（不带当前句子）"
          onClick={() => {
            setFeedbackContext(null);
            setTab('feedback');
          }}
          className="mt-2 rounded-lg border border-white/15 px-2.5 py-1 text-[11.5px] text-white/75"
        >
          普通意见反馈
        </button>
      </footer>
      </div>

      {/* ---- 学习：P3 才做。这一版明确写「未完成」，不放假按钮 ---- */}
      <div hidden={tab !== 'learn'} className="mt-4">
        <section className="surface rounded-2xl border border-white/10 bg-ink-900/80 p-4" data-testid="learn-page">
          <h2 className="text-base font-semibold text-white">英语学习模式 · 未完成（P3）</h2>
          <p className="muted mt-2 text-[12.5px] text-white/60">
            这一版还没有实现下面的功能。列出来是为了说清范围，不是可以点的入口：
          </p>
          <ul className="mt-2 space-y-1 text-[12.5px] text-white/70">
            <li>· 选词看释义、读音和当前句中的意思</li>
            <li>· 生词本（原句 + 用户笔记）、英中显示切换、复习卡</li>
            <li>· 本地音频的 AB 复读与慢速播放（只能控制本应用可控制的音频）</li>
          </ul>
          <p className="mt-3 text-[11.5px] text-white/45">
            词表来源与授权尚未核实，不标为官方完整四六级词库；练习不承诺押题、通过或提分。
            也不声称能控制第三方播放器的跳转或变速。
          </p>
        </section>
      </div>

      {/* ---- 反馈：真入库、真编号、真查询 ---- */}
      <div hidden={tab !== 'feedback'} className="mt-4">
        <section className="surface rounded-2xl border border-white/10 bg-ink-900/80 p-4">
          <FeedbackPanel
            context={feedbackContext}
            version={health?.version}
          />
        </section>
      </div>

      {/* ---- 设置：主题 / 可读性 / 模型与诊断 ---- */}
      <div hidden={tab !== 'settings'} className="mt-4 space-y-4">
        <section className="surface rounded-2xl border border-white/10 bg-ink-900/80 p-4" data-testid="settings-theme">
          <h2 className="text-base font-semibold text-white">主题</h2>
          <p className="muted mt-1 text-[12px] text-white/55">
            三种主题布局完全相同，切换不清空当前字幕、事实卡和回复卡。护眼暖色只是低眩光配色，不作医学效果承诺。
          </p>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="主题选择">
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={themePref === option.value}
                aria-label={`主题：${option.label}。${option.hint}`}
                data-testid={`theme-${option.value}`}
                onClick={() => setThemePref(option.value)}
                className={`rounded-xl px-3 py-2 text-[12.5px] ${
                  themePref === option.value
                    ? 'bg-accent/30 text-white ring-1 ring-accent'
                    : 'border border-white/15 text-white/80'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11.5px] text-white/45" data-testid="theme-active">
            当前生效：{themeName === 'dark' ? '深夜模式' : themeName === 'warm' ? '护眼暖色' : '白色模式'}
            {themePref === 'system' ? '（跟随系统）' : ''}
          </p>
        </section>

        <section className="surface rounded-2xl border border-white/10 bg-ink-900/80 p-4">
          <h2 className="text-base font-semibold text-white">字号与可读性</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-label={`原文与译文整体调小，当前原文 ${originalFont} 像素、译文 ${translationFont} 像素`}
              data-testid="font-smaller"
              onClick={() => {
                setOriginalFont((size) => Math.max(16, size - 2));
                setTranslationFont((size) => Math.max(16, size - 2));
              }}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12.5px] text-white/85"
            >
              A−
            </button>
            <button
              type="button"
              aria-label={`原文与译文整体调大，当前原文 ${originalFont} 像素、译文 ${translationFont} 像素`}
              data-testid="font-larger"
              onClick={() => {
                setOriginalFont((size) => Math.min(48, size + 2));
                setTranslationFont((size) => Math.min(56, size + 2));
              }}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12.5px] text-white/85"
            >
              A+
            </button>
            <button
              type="button"
              aria-pressed={highContrast}
              data-testid="toggle-contrast"
              onClick={() => setHighContrast((value) => !value)}
              className={`rounded-lg border px-3 py-1.5 text-[12.5px] ${
                highContrast ? 'border-warn/60 bg-warn/15 text-warn' : 'border-white/15 text-white/80'
              }`}
            >
              高对比
            </button>
            <button
              type="button"
              aria-pressed={reduceMotion}
              data-testid="toggle-motion"
              onClick={() => setReduceMotion((value) => !value)}
              className={`rounded-lg border px-3 py-1.5 text-[12.5px] ${
                reduceMotion ? 'border-warn/60 bg-warn/15 text-warn' : 'border-white/15 text-white/80'
              }`}
            >
              减少动画
            </button>
            <button
              type="button"
              ref={privacyTrigger}
              data-testid="open-privacy"
              onClick={() => setShowPrivacy(true)}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12.5px] text-white/80"
            >
              隐私与数据
            </button>
            <button
              type="button"
              onClick={() => state.clear()}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-[12.5px] text-white/80"
            >
              清空屏幕
            </button>
          </div>
          <p className="mt-2 text-[11.5px] text-white/45">
            高对比模式独立于三主题；系统设置为「减少动画」时也会自动生效。
          </p>
        </section>

        <section className="surface rounded-2xl border border-white/10 bg-ink-900/80 p-4" data-testid="settings-diagnostics">
          <h2 className="text-base font-semibold text-white">模型详情与诊断</h2>
          <p className="muted mt-1 text-[12px] text-white/55">
            下面这些是服务端 /api/health 真实返回的内容，不是本地写死的清单。
          </p>
          <pre className="mt-3 max-h-64 overflow-auto rounded-xl border border-white/10 bg-ink-950/60 p-3 text-[11.5px] leading-relaxed text-white/75">
{JSON.stringify(
  {
    version: health?.version ?? null,
    mode: health?.mode ?? null,
    real_configured: health?.real ?? null,
    verified_ok: health?.verified ?? null,
    languages: health?.languages ?? null,
    limits: health?.limits ?? null,
    notes: health?.notes ?? [],
    active_theme: themeName,
  },
  null,
  2,
)}
          </pre>
        </section>
      </div>

      {showCard && (cardSentence || state.plan?.ok) ? (
        <BigCard
          sentence={cardSentence?.sentence ?? (state.plan?.ok ? state.plan.sentence : '')}
          meaning={cardSentence?.meaning ?? (state.plan?.ok ? state.plan.meaning : '')}
          onClose={closeCard}
          restoreFocus={cardTrigger}
          onSpeak={(text) => {
            const result = speak(text, 'en-US');
            if (!result.ok && result.reason) setFileNotice(result.reason);
          }}
        />
      ) : null}

      {showPrivacy ? (
        <PrivacySheet
          onClose={closePrivacy}
          health={health}
          serverNote={state.healthError}
          restoreFocus={privacyTrigger}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* 模态基座                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * 所有弹层都走这里，不再各写一套焦点逻辑。
 *
 * 修的是两个实测问题：
 *  1. 大字卡的 `role="dialog"` 只包住文字，朗读和关闭按钮在容器外面 ——
 *     手写的 Tab 环里一个可聚焦元素都查不到，Tab 直接走进背景的 A−。
 *  2. 隐私弹层根本没有 Tab 环、没有背景隔离，Esc 之后焦点也不回入口。
 *
 * 三条硬约束：
 *  - **必须 portal 到 body**：下面会把 `[data-app-shell]` 设成 `inert`，
 *    弹层如果还在 shell 里，会把自己一起禁掉。
 *  - 用真正的 `inert` 属性隔离背景，而不是只靠 Tab 环兜住 —— 读屏的虚拟
 *    光标走的是可访问树，Tab 环拦不住它。
 *  - 关闭时把焦点还给触发它的那颗按钮，否则键盘用户会掉回页首。
 */
function Modal({
  label,
  labelledBy,
  onClose,
  restoreFocus,
  overlayClass,
  panelClass,
  children,
}: {
  label?: string;
  labelledBy?: string;
  onClose: () => void;
  restoreFocus?: React.RefObject<HTMLElement | null>;
  overlayClass: string;
  panelClass: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;

    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.getClientRects().length > 0);

    // 初始焦点落在第一个可操作元素（大字卡是「朗读」，隐私是「知道了」）
    (focusables()[0] ?? node).focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !node.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const shell = document.querySelector<HTMLElement>('[data-app-shell]');
    shell?.setAttribute('inert', '');
    shell?.setAttribute('aria-hidden', 'true');

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      shell?.removeAttribute('inert');
      shell?.removeAttribute('aria-hidden');
      /*
       * 焦点必须回到触发它的按钮。若那颗按钮在弹层打开期间被卸载了
       * （来了新字幕、切了语言），focus 一个 detached 节点是无效的，
       * 浏览器会把焦点丢给 BODY。这时退到主标题这个稳定锚点。
       */
      const target = restoreFocus?.current;
      if (target && document.contains(target)) target.focus();
      else document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
    };
  }, [onClose, restoreFocus]);

  return createPortal(
    <div className={overlayClass}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        className={`outline-none ${panelClass}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function BigCard({
  sentence,
  meaning,
  onClose,
  onSpeak,
  restoreFocus,
}: {
  sentence: string;
  meaning: string;
  onClose: () => void;
  onSpeak: (text: string) => void;
  restoreFocus?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <Modal
      label="给对方看的确认句"
      onClose={onClose}
      restoreFocus={restoreFocus}
      overlayClass="fixed inset-0 z-50 flex flex-col bg-black p-5"
      panelClass="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="big-card">
        <p className="text-[12px] text-white/50">把屏幕转向对方</p>
        <p
          className="mt-4 overflow-y-auto text-[30px] font-semibold leading-tight text-white"
          data-testid="big-card-text"
        >
          {sentence}
        </p>
        <p className="mt-4 text-[14px] text-white/55" data-testid="big-card-meaning">
          {meaning}
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black"
          onClick={() => onSpeak(sentence)}
        >
          朗读（需手动点）
        </button>
        <button
          type="button"
          className="rounded-xl border border-white/25 px-4 py-2 text-sm text-white"
          onClick={onClose}
          data-testid="big-card-close"
        >
          关闭
        </button>
      </div>
    </Modal>
  );
}

function PrivacySheet({
  onClose,
  health,
  serverNote,
  restoreFocus,
}: {
  onClose: () => void;
  health: Health | null;
  serverNote: string | null;
  restoreFocus?: React.RefObject<HTMLElement | null>;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <Modal
      labelledBy="privacy-title"
      onClose={onClose}
      restoreFocus={restoreFocus}
      overlayClass="fixed inset-0 z-50 flex items-end bg-black/80 p-4 sm:items-center sm:justify-center"
      panelClass="surface max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/12 bg-ink-900 p-4"
    >
      <h2 id="privacy-title" className="text-base font-semibold text-white">
        隐私与数据
      </h2>
      <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-white/70">
        <li>
          · 这个页面**默认不保存**对话和录音：不写 localStorage、不上传桌面客户端的历史库；
          刷新即清。你在桌面客户端里的记录不会被读到这里。
        </li>
        <li>
          · 打开页面时会自动做一次健康检查和会话创建（仅这两次，不含你的内容）；
          之后只有你点「翻译」「停止录音」「上传音频」才会发送正文或音频。
        </li>
        <li>
          · 点麦克风才会申请权限，停止时立刻释放；离开页面会停止采集。浏览器录音格式为{' '}
          <code className="text-white/85">webm/opus</code> 或 <code className="text-white/85">mp4</code>，
          取决于浏览器；上传前会转成 16 kHz 单声道 WAV。
        </li>
        <li>
          · 文字与音频会发送到**网站后端**（同一域名下的 <code>/api</code>），由服务器上的模型处理，
          不是在你自己的设备里算。后端对音频写临时文件、识别完立即删除；日志只留状态码、错误码与耗时，
          不留正文和译文。
        </li>
        <li>
          · 模型 Key 只存在服务器环境变量里，网页、浏览器存储和日志里都没有。
          如果以后接入云端模型服务，接收方会在下面的「当前能力」里写明。
        </li>
        <li>
          · 当前能力：
          {health
            ? `翻译 = ${modeLabel(health.mode.translate)}；识别 = ${modeLabel(health.mode.transcribe)}；回复 = ${modeLabel(health.mode.reply)}`
            : serverNote ?? '服务端状态未知'}
          。
        </li>
        <li>
          · 匿名访问有次数上限（服务端按会话计数）：翻译与识别各自计数，用完会明确提示，不会静默失败。
        </li>
        <li>· 删除网站上的内容不会影响桌面客户端里已保存的记录，也不会删除你已导出的文件。</li>
      </ul>
      <button
        ref={closeRef}
        type="button"
        className="mt-4 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-ink-950"
        onClick={onClose}
        data-testid="privacy-close"
      >
        知道了
      </button>
    </Modal>
  );
}

/**
 * 关键信息对不上时的警示。
 *
 * 用 `role="alert"`：这是「必须先被读屏听到」的一类，而且只在真的对不上时
 * 出现，不会像逐帧字幕那样反复打断。文案给出**原文是什么**，因为判断依据
 * 永远是原文，不是译文。
 */
function NumericWarning({ check }: { check: NumericCheck | null }) {
  if (!check || check.level !== 'warn') return null;

  const items: string[] = [];
  const srcNumbers = check.numbers.source.map((h) => `${h.raw}（${h.value}）`).join('、');
  for (const hit of check.numbers.unsourced) {
    items.push(`译文里的「${hit.raw}」在原文中找不到。${srcNumbers ? `原文是：${srcNumbers}` : ''}`);
  }
  for (const hit of check.numbers.missing) {
    items.push(`原文的「${hit.raw}」（${hit.value}）在译文里没有出现`);
  }
  for (const hit of check.times.unsourced) {
    const src = check.times.source.map((t) => t.raw).join('、');
    items.push(`译文时间「${hit.raw}」与原文${src ? `「${src}」` : '（原文没有时间）'}对不上`);
  }
  for (const hit of check.times.missing) {
    items.push(`原文时间「${hit.raw}」在译文里没有出现`);
  }
  for (const hit of check.days.unsourced) {
    items.push(`译文里的「${hit.raw}」在原文中没有对应日期`);
  }
  for (const hit of check.days.missing) {
    items.push(`原文的「${hit.raw}」在译文里没有出现`);
  }
  if (!check.negation.ok) {
    items.push(`否定关系对不上：原文否定 ${check.negation.source.length} 处、译文 ${check.negation.target.length} 处`);
  }
  if (!items.length) return null;

  return (
    <div
      role="alert"
      data-testid="numeric-warning"
      className="mt-3 rounded-xl border border-danger/45 bg-danger/12 p-3 text-[13px] leading-relaxed"
    >
      <p className="font-medium text-danger">关键信息对不上，请按原文核对</p>
      <ul className="mt-1.5 space-y-1 text-white/80">
        {items.map((text) => (
          <li key={text}>· {text}</li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-white/55">
        下面的重点信息取自原文，按它核对；确认句也用原文生成。
      </p>
    </div>
  );
}

/**
 * 译文里的可疑数字就地标出来。
 *
 * 下面的警示块能说清「哪里错了」，但用户是**看着译文**的，视线不在下面。
 * 所以这里不改译文（暗改等于替他做决定），只在原文找不到的值上打标记，
 * 让他一眼看到「这个数不能信」。
 */
function TranslationText({ text, check }: { text: string; check: NumericCheck | null }) {
  if (!check || check.level !== 'warn') return <>{text}</>;

  const marks = [
    ...check.numbers.unsourced.map((h) => ({ start: h.start, end: h.end, value: h.raw })),
    ...check.times.unsourced.map((h) => ({ start: h.start, end: h.end, value: h.raw })),
  ]
    .filter((m) => m.end > m.start && m.end <= text.length)
    .sort((a, b) => a.start - b.start);

  // 去掉重叠（`12 000` 与 `2 000` 这种嵌套命中只保前一个）
  const kept: typeof marks = [];
  let cursor0 = -1;
  for (const mark of marks) {
    if (mark.start < cursor0) continue;
    kept.push(mark);
    cursor0 = mark.end;
  }
  if (!kept.length) return <>{text}</>;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  kept.forEach((mark, index) => {
    if (mark.start > cursor) nodes.push(text.slice(cursor, mark.start));
    nodes.push(
      <mark
        key={`${mark.value}-${index}`}
        className="rounded bg-danger/30 px-0.5 text-white underline decoration-danger decoration-wavy underline-offset-2"
        title="原文里找不到这个值，按原文核对"
      >
        {text.slice(mark.start, mark.end)}
      </mark>,
    );
    cursor = mark.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

/** 事实值的中文读法：`twelve thousand` 旁边标「一万二千」，不用自己换算。 */
function ChineseReading({ value }: { value: string }) {
  const zh = toChineseSpeech(value);
  const text = (value ?? '').trim();
  if (!zh || zh === text) return null;
  return <span className="text-[12px] text-white/45">（{zh}）</span>;
}
