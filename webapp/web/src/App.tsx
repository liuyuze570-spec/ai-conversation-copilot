import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SAMPLE_CASES } from '@shared/samples';
import { useApp } from './state';
import {
  detectCapabilities,
  describeMicError,
  hasVoiceFor,
  speak,
  startRecording,
  type Capabilities,
  type MicError,
  type RecorderHandle,
} from './adapter/browser';
import { toWav } from './adapter/wav';
import { hintsFor, needsWording } from './lib/pipeline';
import { modeLabel, type Health } from './api';

const ZH_EN_SAMPLES = SAMPLE_CASES.map((sample) => {
  const variant = sample.variants['zh-en'];
  return variant ? { id: sample.id, title: sample.title, ...variant } : null;
}).filter((item): item is NonNullable<typeof item> => Boolean(item));

type MicState = 'idle' | 'recording' | 'processing';

function Badge({ tone, children }: { tone: 'real' | 'preset' | 'warn' | 'muted'; children: ReactNode }) {
  const map = {
    real: 'border-ok/40 bg-ok/10 text-ok',
    preset: 'border-warn/40 bg-warn/10 text-warn',
    warn: 'border-danger/40 bg-danger/10 text-danger',
    muted: 'border-white/12 bg-white/5 text-white/60',
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
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [wording, setWording] = useState<{ id: string; value: string } | null>(null);
  const recorder = useRef<RecorderHandle | null>(null);
  const cardTrigger = useRef<HTMLButtonElement | null>(null);

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
    ) : state.translateMode ? (
      <Badge tone={state.translateMode === 'mock' ? 'warn' : 'real'}>{modeLabel(state.translateMode)}</Badge>
    ) : null;

  const sttBadge =
    state.transcribeMode === 'mock' ? <Badge tone="warn">识别：预置结果</Badge> : null;

  const hints = useMemo(
    () => (state.original && state.translateMode !== 'preset' ? hintsFor(state.original) : null),
    [state.original, state.translateMode],
  );

  const closeCard = useCallback(() => {
    setShowCard(false);
    cardTrigger.current?.focus();
  }, []);

  return (
    <div className="mx-auto min-h-screen w-full max-w-3xl px-4 pb-24 pt-4">
      <header className="surface rounded-2xl border border-white/10 bg-ink-900/80 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-white">英语沟通字幕助手</h1>
            <p className="muted mt-1 text-[12.5px] text-white/55">
              看清对方说的英语 → 核对时间、金额和否定 → 说一句确认。网页版，免注册。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">{modeBadges}</div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-white/12 px-2.5 py-1 text-[12px] text-white/80"
            onClick={() => setOriginalFont((size) => Math.max(16, size - 2))}
            aria-label="原文与译文整体调小"
          >
            A−
          </button>
          <button
            type="button"
            className="rounded-lg border border-white/12 px-2.5 py-1 text-[12px] text-white/80"
            onClick={() => {
              setOriginalFont((size) => Math.min(48, size + 2));
              setTranslationFont((size) => Math.min(56, size + 2));
            }}
            aria-label="原文与译文整体调大"
          >
            A+
          </button>
          <button
            type="button"
            aria-pressed={highContrast}
            className={`rounded-lg border px-2.5 py-1 text-[12px] ${
              highContrast ? 'border-warn/60 bg-warn/15 text-warn' : 'border-white/12 text-white/80'
            }`}
            onClick={() => setHighContrast((value) => !value)}
          >
            高对比
          </button>
          <button
            type="button"
            className="rounded-lg border border-white/12 px-2.5 py-1 text-[12px] text-white/80"
            onClick={() => setShowPrivacy(true)}
          >
            隐私与数据
          </button>
          <button
            type="button"
            className="rounded-lg border border-white/12 px-2.5 py-1 text-[12px] text-white/80"
            onClick={() => state.clear()}
          >
            清空屏幕
          </button>
        </div>
      </header>

      <Section title="1 · 对方的英语" hint="打字、录音，或点一条预置样例">
        <label className="muted text-[12px] text-white/55" htmlFor="original-input">
          原文（英语）
        </label>
        <textarea
          id="original-input"
          data-testid="original-input"
          className="mt-1.5 min-h-[92px] w-full resize-y rounded-xl border border-white/12 bg-ink-950/70 p-3 text-[15px] leading-relaxed text-white outline-none focus-visible:border-accent"
          placeholder="例如：Please send the report by 3 p.m. tomorrow."
          value={state.original}
          onChange={(event) => state.setOriginal(event.target.value)}
          spellCheck={false}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="translate"
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-ink-950 disabled:opacity-40"
            disabled={!state.original.trim() || state.stage !== 'idle'}
            onClick={() => void state.translate(state.original, 'text')}
          >
            翻译成中文
          </button>
          {micState === 'idle' ? (
            <button
              type="button"
              data-testid="mic-start"
              className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/85"
              disabled={caps?.mic !== 'ok'}
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
              onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
            />
          </label>
        </div>

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
      </Section>

      <div aria-live="polite" className="mt-2 min-h-[20px] text-[12px] text-white/60">
        {state.notice?.kind === 'error' ? <span className="text-danger">{state.notice.text}</span> : null}
        {state.notice?.kind === 'warn' ? <span className="text-warn">{state.notice.text}</span> : null}
        {!state.notice && stageText ? <span>{stageText}</span> : null}
        {!state.notice && !stageText && state.translateMode && state.translateMode !== 'preset' ? (
          <span>
            翻译完成 · {state.elapsedMs != null ? `${(state.elapsedMs / 1000).toFixed(2)}s` : '耗时未返回'}
            {state.requestId ? ` · 请求 ${state.requestId.slice(0, 8)}` : ''}
          </span>
        ) : null}
      </div>

      {state.original && (state.translation || state.translateMode === 'preset') ? (
        <Section title="2 · 字幕" hint="原文在上，中文在下；字号可单独调">
          <div className="flex flex-wrap items-center gap-2">
            {sourceBadge}
            {sttBadge}
          </div>
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
            {state.translation}
          </p>
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
                  {fact.negated ? <Badge tone="warn">被对方否定，不作数</Badge> : null}
                  {fact.edited ? <Badge tone="real">已由你改成「{fact.value}」</Badge> : null}
                  {needsWording(fact) ? <Badge tone="warn">需补说法</Badge> : null}
                  <span className="muted text-[11.5px] text-white/40">原话：{fact.sourceText}</span>
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
                  <label className="flex items-center gap-1.5 text-[12px] text-white/70">
                    <input
                      type="checkbox"
                      checked={fact.checked}
                      onChange={() => state.toggleFact(fact.id)}
                      data-testid="fact-check"
                    />
                    核对这条
                  </label>
                  <button
                    type="button"
                    className="rounded-lg border border-white/12 px-2 py-0.5 text-[12px] text-white/70"
                    onClick={() => setEditing({ id: fact.id, value: fact.value })}
                  >
                    修改
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/12 px-2 py-0.5 text-[12px] text-white/70"
                    onClick={() => setWording({ id: fact.id, value: fact.spoken ?? '' })}
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
              className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/85"
              onClick={() => void state.askReply()}
            >
              给我一句回复建议
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
                    ref={cardTrigger}
                    data-testid="show-card"
                    className="rounded-lg bg-white/10 px-3 py-1.5 text-[12px] text-white"
                    onClick={() => setShowCard(true)}
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

          {state.replyText ? (
            <div className="mt-3 rounded-xl border border-white/10 bg-white/4 p-3">
              <p className="text-[11.5px] text-white/45">
                参考回复（{state.replyMode ? modeLabel(state.replyMode) : '未知来源'}，请自己判断要不要说）
              </p>
              <p className="mt-1 text-[15px] text-white" data-testid="reply-text">
                {state.replyText}
              </p>
            </div>
          ) : null}
        </Section>
      ) : null}

      <footer className="mt-6 text-[11.5px] leading-relaxed text-white/40">
        <p>
          本页默认不在浏览器里保存对话与录音；服务端只在内存里处理，重启即清。用到的模型与接收方见「隐私与数据」。
        </p>
        <p className="mt-1">
          重点信息由规则提取，可能与原话有出入；确认句请当面再核一遍。网页不做 Windows 系统声音采集，那条链路由桌面客户端负责。
        </p>
      </footer>

      {showCard && state.plan?.ok ? (
        <BigCard
          sentence={state.plan.sentence}
          meaning={state.plan.meaning}
          onClose={closeCard}
          onSpeak={(text) => {
            const result = speak(text, 'en-US');
            if (!result.ok && result.reason) setFileNotice(result.reason);
          }}
        />
      ) : null}

      {showPrivacy ? (
        <PrivacySheet
          onClose={() => setShowPrivacy(false)}
          health={health}
          serverNote={state.healthError}
        />
      ) : null}
    </div>
  );
}

function BigCard({
  sentence,
  meaning,
  onClose,
  onSpeak,
}: {
  sentence: string;
  meaning: string;
  onClose: () => void;
  onSpeak: (text: string) => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = cardRef.current;
    node?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !node) return;
      // 手写 Tab 环：卡片打开时焦点不许跑到背景上。
      const focusable = node.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-between bg-black p-5">
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="给对方看的确认句"
        className="flex min-h-0 flex-1 flex-col outline-none"
        data-testid="big-card"
      >
        <p className="text-[12px] text-white/50">把屏幕转向对方</p>
        <p className="mt-4 overflow-y-auto text-[30px] font-semibold leading-tight text-white" data-testid="big-card-text">
          {sentence}
        </p>
        <p className="mt-4 text-[14px] text-white/55">{meaning}</p>
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
    </div>
  );
}

function PrivacySheet({
  onClose,
  health,
  serverNote,
}: {
  onClose: () => void;
  health: Health | null;
  serverNote: string | null;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/80 p-4 sm:items-center sm:justify-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-title"
        className="surface max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/12 bg-ink-900 p-4"
      >
        <h2 id="privacy-title" className="text-base font-semibold text-white">
          隐私与数据
        </h2>
        <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-white/70">
          <li>
            · 本页**默认不保存**对话与录音：不写 localStorage、不上传历史库；刷新即清。桌面客户端已有的历史不会被读到这里。
          </li>
          <li>· 你不点「翻译」「录音」「上传音频」时，不会发出任何请求。</li>
          <li>
            · 点麦克风才会申请权限，停止时立刻释放；离开页面会停止采集。浏览器录音格式为{' '}
            <code className="text-white/85">webm/opus</code> 或 <code className="text-white/85">mp4</code>，
            取决于浏览器，服务端两种都能解。
          </li>
          <li>
            · 文字与音频会发到本项目的后端（同一域名下的 <code>/api</code>）。后端只保留必要状态、错误码与耗时，
            不保留正文；模型 Key 只在服务端环境变量里，浏览器里没有。
          </li>
          <li>
            · 当前能力：
            {health
              ? `翻译 = ${modeLabel(health.mode.translate)}；识别 = ${modeLabel(health.mode.transcribe)}`
              : serverNote ?? '服务端状态未知'}
            。
          </li>
          <li>· 匿名访问有次数上限（服务端按会话计数），用完会明确提示，不会静默失败。</li>
        </ul>
        <button
          ref={closeRef}
          type="button"
          className="mt-4 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-ink-950"
          onClick={onClose}
        >
          知道了
        </button>
      </div>
    </div>
  );
}
