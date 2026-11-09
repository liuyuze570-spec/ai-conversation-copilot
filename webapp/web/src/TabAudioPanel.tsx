/**
 * P2「翻译其他网页视频」面板：两条字幕轨道。
 *
 * ① 逐句字幕：保持原样，一条一条出，不变。
 * ② 整段连贯翻译：把到目前为止**全部**句子合起来翻一次，由暂停或停止自动触发。
 *
 * 界面纪律：不把「自检音频」说成视频原声，不把「并排字幕」说成跨网页悬浮字幕，
 * 不把未测的平台说成已支持，不把过期的整段译文说成实时。状态与错误都有文字。
 */
import { useEffect, useRef, useState } from 'react';
import { percentile } from '@shared/caption-pipeline';
import { useApp } from './state';
import {
  TabAudioSession,
  emptyPassage,
  type CaptureLine,
  type CaptureState,
  type CaptureStats,
  type PassageTranslation,
} from './tabAudio';

interface StateView {
  value: CaptureState;
  detail: string;
}

interface TestHook {
  inject: (stream: MediaStream) => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => void;
  refreshPassage: () => Promise<void>;
  snapshot: () => {
    state: string;
    detail: string;
    label: string;
    error: string;
    lines: CaptureLine[];
    stats: CaptureStats;
    transcript: string[];
    passage: PassageTranslation;
  };
}

declare global {
  interface Window {
    __COPILOT_TAB_AUDIO_TEST__?: TestHook;
  }
}

const EMPTY_STATS: CaptureStats = {
  slices: 0, sent: 0, silent: 0, dropped: 0, lines: 0,
  budgetLeft: null, asrMs: [], translateMs: [], totalMs: [],
};

function stateLabel(value: CaptureState): string {
  switch (value) {
    case 'waiting-sound': return '等待声音';
    case 'capturing': return '采集中';
    case 'requesting': return '等待授权';
    case 'error': return '已停止（有问题）';
    case 'stopping': return '停止中';
    case 'stopped': return '已停止';
    case 'paused': return '已暂停';
    default: return '空闲';
  }
}

export function TabAudioPanel() {
  const sessionRef = useRef<TabAudioSession | null>(null);
  const [view, setView] = useState<StateView>({ value: 'idle', detail: '尚未开始采集' });
  const [lines, setLines] = useState<CaptureLine[]>([]);
  const [stats, setStats] = useState<CaptureStats>(EMPTY_STATS);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [transcript, setTranscript] = useState<string[]>([]);
  const [passage, setPassage] = useState<PassageTranslation>(emptyPassage);
  const viewRef = useRef(view);
  const linesRef = useRef(lines);
  const statsRef = useRef(stats);
  const errorRef = useRef(error);
  const labelRef = useRef(label);
  const transcriptRef = useRef(transcript);
  const passageRef = useRef(passage);

  useEffect(() => {
    const session = new TabAudioSession({
      onState: (value, detail) => {
        const next = { value, detail };
        viewRef.current = next;
        setView(next);
        if (value !== 'error') {
          errorRef.current = '';
          setError('');
        }
        labelRef.current = session.label;
        setLabel(session.label);
      },
      onLine: (line) => {
        linesRef.current = [...linesRef.current, line];
        setLines(linesRef.current);
      },
      onStats: (next) => {
        statsRef.current = next;
        setStats(next);
      },
      onError: (_code, message) => {
        errorRef.current = message;
        setError(message);
      },
      onTranscript: (sentences) => {
        transcriptRef.current = sentences;
        setTranscript(sentences);
      },
      onPassage: (next) => {
        passageRef.current = next;
        setPassage(next);
      },
    });
    sessionRef.current = session;

    /*
     * 自动化自检注入口：只接一条真实音频 MediaStream，用来验证
     * 「切片 → 识别 → 断句 → 翻译」链路。它**不能**代替真人在浏览器弹窗里
     * 选择视频标签页，界面会把来源标成「自检音频」。
     */
    window.__COPILOT_TAB_AUDIO_TEST__ = {
      inject: (stream) => session.startWithStream(stream, 'selftest-wav'),
      stop: () => session.stop(),
      pause: () => session.pause(),
      resume: () => session.resume(),
      refreshPassage: () => session.refreshPassage(),
      snapshot: () => ({
        state: viewRef.current.value,
        detail: viewRef.current.detail,
        label: labelRef.current,
        error: errorRef.current,
        lines: linesRef.current,
        stats: statsRef.current,
        transcript: transcriptRef.current,
        passage: passageRef.current,
      }),
    };
    return () => {
      delete window.__COPILOT_TAB_AUDIO_TEST__;
      session.dispose();
      void session.stop({ translate: false });
    };
  }, []);

  const paused = view.value === 'paused';
  const active = view.value === 'requesting' || view.value === 'capturing' ||
    view.value === 'waiting-sound' || view.value === 'stopping' || paused;
  const canPause = (view.value === 'capturing' || view.value === 'waiting-sound') && !paused;
  const latency = stats.totalMs;
  const sourceText = label === 'selftest-wav'
    ? '自检音频（本地合成语音，不是视频原声）'
    : label === 'video-tab'
      ? '你选择的视频标签页音频'
      : '未选择音源';
  const passageReady = passage.status === 'done' && Boolean(passage.translation.trim());

  const usePassageForReply = () => {
    const current = passageRef.current;
    if (current.status !== 'done' || !current.translation.trim()) return;
    void useApp.getState().usePassageForReply(
      current.text || transcriptRef.current.join(' '),
      current.translation,
      transcriptRef.current,
    );
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <section className="surface mt-4 rounded-2xl border border-white/10 bg-ink-900/70 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-white/85">
          翻译其他网页视频
          <span className="ml-2 rounded-lg border border-warn/50 px-2 py-0.5 text-[11px] font-normal text-warn">
            P2 · 双轨 · 并排显示
          </span>
        </h2>
        <span className="muted text-[11px] text-white/45">桌面 Chrome / Edge · 需你主动授权</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="tab-audio-start"
          className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-ink-950 disabled:opacity-40"
          disabled={active}
          onClick={() => void sessionRef.current?.start()}
        >
          选择视频标签页并开始
        </button>
        <button
          type="button"
          data-testid="tab-audio-pause"
          className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/85 disabled:opacity-40"
          disabled={!canPause}
          onClick={() => void sessionRef.current?.pause()}
        >
          暂停并整段翻译
        </button>
        <button
          type="button"
          data-testid="tab-audio-resume"
          className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/85 disabled:opacity-40"
          disabled={!paused}
          onClick={() => sessionRef.current?.resume()}
        >
          继续采集
        </button>
        <button
          type="button"
          data-testid="tab-audio-stop"
          className="rounded-xl border border-white/15 px-3 py-2 text-sm text-white/85 disabled:opacity-40"
          disabled={!active}
          onClick={() => void sessionRef.current?.stop()}
        >
          停止并释放
        </button>
        <span className="muted text-[11.5px] text-white/55" data-testid="tab-audio-source">
          音源：{sourceText}
        </span>
      </div>

      <p
        className="mt-2.5 rounded-xl border border-white/10 bg-white/4 px-3 py-2 text-[12px] text-white/75"
        role="status"
        aria-live="polite"
        data-testid="tab-audio-state"
      >
        {stateLabel(view.value)}{' · '}{view.detail}
      </p>
      {error ? (
        <p className="mt-2 text-[12px] text-danger" role="alert" data-testid="tab-audio-error">
          {error}
        </p>
      ) : null}

      <details className="mt-2.5 text-[12px] text-white/65">
        <summary className="cursor-pointer text-white/80">它怎么工作 / 隐私与限制</summary>
        <ul className="mt-2 space-y-1 pl-4" style={{ listStyle: 'disc' }}>
          <li>由你在浏览器弹窗里亲自选择标签页，并勾选「分享标签页音频」。没有勾选时不会采集，也<strong>不会</strong>改用麦克风冒充。</li>
          <li>只读取音频轨；画面轨不接元素、不取帧、不上传。视频本身的声音照常播放，助手这边以静音增益驱动音频图，不会二次播放形成回环。</li>
          <li><strong>两条轨道</strong>：① 逐句字幕保持原样、一条一条出；② 整段连贯翻译把目前全部句子合起来翻一次，不逐句重翻。</li>
          <li><strong>点「暂停并整段翻译」或「停止并释放」会自动按全部内容整段翻译</strong>；点「继续采集」不用再选标签页，继续累积，整段译文会标「已过期」，下次暂停/停止再刷新。</li>
          <li>音频在本机切成短片（默认 3 秒、16kHz 单声道 WAV），按编号串行送识别，再断句、翻译。没有声音时只显示「等待声音」，不生成字幕。</li>
          <li>识别在本服务端完成（本地 faster-whisper 或服务端配置的识别接口），不把画面或整段录音传给第三方。</li>
          <li>片段只做字幕，<strong>不对每个小片段生成回复</strong>；想回复时点某句「用这句继续」，或点整段轨的「用全部内容生成回复」。</li>
          <li>停止会取消排队、弃掉在途请求并释放全部采集轨道。</li>
          <li>首版是<strong>并排</strong>显示：把助手窗口和视频窗口并排放置。跨网页悬浮字幕未实现，不声称普通网页已有全局悬浮能力。</li>
          <li>首版只验证英语→中文。抖音网页版、腾讯视频、爱奇艺<strong>均未测试</strong>；B站有一次用户现场截图显示标签页音频共享成功并出字幕，但未经助手逐项实测，兼容表不标「已支持」。受保护内容不绕过保护。</li>
        </ul>
      </details>

      <div
        className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-white/60"
        data-testid="tab-audio-stats"
      >
        <span>切片 {stats.slices}</span>
        <span>上传 {stats.sent}</span>
        <span>静音丢弃 {stats.silent}</span>
        <span>积压丢弃 {stats.dropped}</span>
        <span>成句 {stats.lines}</span>
        <span>音频预算剩余 {stats.budgetLeft === null ? '未知' : `${Math.round(stats.budgetLeft)} 秒`}</span>
        <span>
          端到端延迟 p50 {Math.round(percentile(latency, 50))}ms / p95 {Math.round(percentile(latency, 95))}ms
          {latency.length ? `（${latency.length} 条实测）` : '（尚无样本）'}
        </span>
      </div>

      {/* ---- ② 整段连贯翻译（根据全部内容） ---- */}
      <div
        className="mt-4 rounded-xl border border-accent/35 bg-accent/5 p-3"
        data-testid="tab-audio-passage"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold text-white/90">
            ② 整段连贯翻译（根据全部内容）
          </h3>
          <span className="muted text-[11px] text-white/50" data-testid="tab-audio-passage-status">
            {passage.status === 'idle' ? '等待暂停或停止' :
              passage.status === 'translating' ? '正在整段翻译' :
                passage.status === 'error' ? '整段翻译失败' : '已完成'}
            {' · '}覆盖 {passage.covered}/{passage.total} 句
            {passage.chunks ? ` · ${passage.chunks} 块` : ''}
            {passage.modes.length ? ` · ${passage.modes.join(' / ')}` : ''}
            {passage.ms ? ` · ${passage.ms}ms` : ''}
            {passage.trigger ? ` · ${passage.trigger === 'pause' ? '暂停自动触发' : passage.trigger === 'stop' ? '停止自动触发' : '手动刷新'}` : ''}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="tab-audio-passage-refresh"
            className="rounded-lg border border-white/20 px-2.5 py-1 text-[11.5px] text-white/85 disabled:opacity-40"
            disabled={!transcript.length || passage.status === 'translating'}
            onClick={() => void sessionRef.current?.refreshPassage()}
          >
            刷新整段翻译
          </button>
          <button
            type="button"
            data-testid="tab-audio-passage-use"
            className="rounded-lg border border-accent/60 bg-accent/10 px-2.5 py-1 text-[11.5px] text-white/90 disabled:opacity-40"
            disabled={!passageReady}
            onClick={usePassageForReply}
          >
            用全部内容生成回复
          </button>
          <span className="muted text-[11px] text-white/50">
            {transcript.length ? `已累积 ${transcript.length} 句` : '还没有累积内容'}
          </span>
        </div>

        {passage.stale ? (
          <p className="mt-2 rounded-lg border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-[11.5px] text-warn" role="status">
            继续采集后有 {passage.total - passage.covered} 句新内容还没纳入这段译文。它是暂停/停止那一刻的快照，不是实时译文；再暂停或点「刷新整段翻译」即可更新。
          </p>
        ) : null}
        {passage.error ? (
          <p className="mt-2 text-[11.5px] text-warn" role="status">{passage.error}</p>
        ) : null}

        <p
          className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-white/90"
          lang="zh-CN"
          data-testid="tab-audio-passage-translation"
        >
          {passage.translation ||
            (passage.status === 'translating'
              ? '正在按全部内容整段翻译…'
              : '还没有整段译文。开始采集后点「暂停并整段翻译」或「停止并释放」，会自动把到目前为止的全部内容翻成一段。')}
        </p>

        {transcript.length ? (
          <details className="mt-2 text-[11.5px] text-white/60" data-testid="tab-audio-transcript">
            <summary className="cursor-pointer text-white/75">查看累积原文（{transcript.length} 句）</summary>
            <p className="mt-1.5 whitespace-pre-wrap leading-relaxed" lang="en">
              {transcript.map((item, index) => `${index + 1}. ${item}`).join('\n')}
            </p>
          </details>
        ) : null}
      </div>

      {/* ---- ① 逐句字幕（保持原样） ---- */}
      <div className="mt-4" data-testid="tab-audio-lines">
        <h3 className="mb-2 text-[13px] font-semibold text-white/90">
          ① 逐句字幕（一条一条，保持原样）
        </h3>
        {lines.length === 0 ? (
          <p className="muted text-[12px] text-white/45" data-testid="tab-audio-empty">
            还没有字幕。开始采集并让视频出声后，识别到的句子会按编号出现在这里。
          </p>
        ) : (
          <div className="space-y-2">
            {lines.map((line) => (
              <article
                key={`${line.seq}-${line.text.slice(0, 12)}`}
                className="rounded-xl border border-white/10 bg-white/4 px-3 py-2"
                data-testid={`tab-audio-line-${line.seq}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="muted text-[11px] text-white/50">
                    #{line.seq} · 识别 {line.asrMode} · 翻译 {line.translateMode} · {line.totalMs}ms
                    {line.partial ? ' · 半句（没等到句号）' : ''}
                  </span>
                  <button
                    type="button"
                    className="rounded-lg border border-white/20 px-2 py-0.5 text-[11px] text-white/80"
                    data-testid={`tab-audio-use-${line.seq}`}
                    onClick={() => {
                      const context = transcriptRef.current
                        .filter((item) => item !== line.text)
                        .slice(-6);
                      void useApp.getState().translate(line.text, 'text', undefined, context);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  >
                    用这句继续
                  </button>
                </div>
                <p className="mt-1 text-[14px] text-white/90" lang="en">{line.text}</p>
                <p className="mt-0.5 text-[13px] text-white/70" lang="zh-CN">
                  {line.translation || '（这句翻译失败，只保留识别到的原文）'}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
