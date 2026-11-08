import { useEffect, useMemo, useState } from 'react';
import { useLatencyStore } from '../../stores/latency';
import {
  PROBE_AUDIO_MS,
  latencyVerdict,
  summarizeLatency,
  type LatencyVerdict,
} from '../../../shared/latency';
import type { SttLatencyProbe } from '../../../shared/ipc';
import { Button, Section } from './controls';

/**
 * 「性能」面板：把「到底慢在哪一段」摆到桌面上。
 *
 * 为什么需要它：整条链路每一跳都是整段返回，而演示模式是本地 mock，
 * 毫秒级就回来 —— 所以「跑起来挺流畅」完全是假象。真实 Key 之下瓶颈在哪，
 * 以前只能靠猜。这个面板就是那块秒表：装了真 Key、放一段外语视频，
 * 看这里的数字再决定优化什么，而不是凭感觉改代码。
 */

const TONE: Record<LatencyVerdict['level'], { box: string; title: string; dot: string }> = {
  idle: { box: 'border-line-soft bg-ink-800', title: 'text-white/60', dot: 'bg-white/30' },
  ok: { box: 'border-ok/25 bg-ok/12', title: 'text-ok', dot: 'bg-ok' },
  watch: { box: 'border-warn/25 bg-warn/12', title: 'text-warn', dot: 'bg-warn' },
  bad: { box: 'border-danger/25 bg-danger/12', title: 'text-danger', dot: 'bg-danger' },
};

/** 主动测速用的音频长度。与主进程、体检结论共用同一个常量，别各写各的。 */
const PROBE_SECONDS = PROBE_AUDIO_MS / 1000;

function Metric({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg bg-ink-800 px-2.5 py-2">
      <p className="text-[10px] text-white/35">{label}</p>
      <p className="tnum mt-0.5 text-[15px] font-semibold leading-none text-white/90">
        {value}
        {unit && <span className="ml-1 text-[10px] font-normal text-white/40">{unit}</span>}
      </p>
      {hint && <p className="mt-1 text-[9.5px] leading-tight text-white/25">{hint}</p>}
    </div>
  );
}

function ms(value: number): string {
  return value > 0 ? String(Math.round(value)) : '—';
}

export function PerformanceSettings() {
  const snapshot = useLatencyStore((state) => state.snapshot);
  const refresh = useLatencyStore((state) => state.refresh);
  const clear = useLatencyStore((state) => state.clear);

  const [probeResult, setProbeResult] = useState<SttLatencyProbe | null>(null);
  const [probing, setProbing] = useState(false);

  const runProbe = async () => {
    setProbing(true);
    try {
      setProbeResult(await window.copilot.latencyProbeStt());
    } catch (error) {
      setProbeResult({
        ok: false,
        ms: 0,
        audioMs: PROBE_AUDIO_MS,
        model: '',
        chars: 0,
        message: String(error).slice(0, 120),
      });
    } finally {
      setProbing(false);
      // 成功的样本由主进程留下来，这里再主动拉一次，保证界面一定刷新
      // （推送和这次 await 的先后顺序不保证）。
      void refresh();
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = useMemo(() => summarizeLatency(snapshot), [snapshot]);
  const verdict = useMemo(() => latencyVerdict(summary), [summary]);
  const tone = TONE[verdict.level];

  // 只展示整句：中途结果只是让字幕先动起来，它的耗时代表不了最终体验。
  const recent = useMemo(
    () =>
      snapshot.records
        .filter((record) => !record.partial)
        .slice(-8)
        .reverse(),
    [snapshot.records],
  );

  const hasSamples = summary.count > 0;

  return (
    <div data-perf-panel>
      <div className={`mb-3 rounded-xl border px-3 py-2.5 ${tone.box}`}>
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
          <div className="min-w-0">
            <p data-perf-verdict className={`text-[12.5px] font-semibold leading-snug ${tone.title}`}>
              {verdict.title}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-white/50">{verdict.hint}</p>
          </div>
        </div>
      </div>

      <Section
        title="各段实测耗时"
        aside={
          <span data-perf-count className="tnum text-[10px] text-white/35">
            {summary.count} 句样本
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          <Metric
            label="语音识别 · 平均"
            value={ms(summary.sttAvg)}
            unit="毫秒"
            hint={hasSamples ? `最慢 5% 超过 ${ms(summary.sttP95)} 毫秒` : '还没有样本'}
          />
          <Metric
            label="翻译 · 平均"
            value={ms(summary.translateAvg)}
            unit="毫秒"
            hint={
              summary.translateSamples
                ? `最慢 5% 超过 ${ms(summary.translateP95)} 毫秒`
                : '还没有样本'
            }
          />
          <Metric
            label="说完到看到译文"
            value={ms(summary.e2eAvg)}
            unit="毫秒"
            hint={hasSamples ? '识别 + 翻译，用户实际等待的时间' : '还没有样本'}
          />
          <Metric
            label="生成回复 · 平均"
            value={ms(summary.replyAvg)}
            unit="毫秒"
            hint={
              summary.replySamples
                ? // 一定要带「最慢」：实测出现过平均 7 秒、单次 52 秒（超时重试），
                  // 只报平均值会让这条尾巴完全隐身。
                  `${summary.replySamples} 次 · 最慢 5% 超过 ${ms(summary.replyP95)} 毫秒`
                : '还没有样本'
            }
          />
        </div>

        <div
          className={`mt-2 rounded-lg px-2.5 py-2 ${
            summary.rtfAvg >= 1.15 ? 'bg-danger/12' : 'bg-ink-800'
          }`}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] text-white/35">实时率（识别耗时 ÷ 音频时长）</span>
            <span
              data-perf-rtf
              className={`tnum text-[15px] font-semibold leading-none ${
                summary.rtfAvg >= 1.15 ? 'text-danger' : 'text-white/90'
              }`}
            >
              {summary.rtfAvg > 0 ? summary.rtfAvg.toFixed(2) : '—'}
            </span>
          </div>
          <p className="mt-1.5 text-[9.5px] leading-relaxed text-white/30">
            小于 1 才叫跟得上：识别一段 3 秒的话，必须在 3 秒内出结果，否则字幕会
            越落越远。它跟网速快慢无关，只跟「能不能跟上」有关。
          </p>
        </div>
      </Section>

      <Section
        title="真实识别测速"
        aside={
          <Button variant="primary" onClick={() => void runProbe()} disabled={probing} dataAttr="data-perf-probe">
            {probing ? '正在测…' : '测一次'}
          </Button>
        }
      >
        <p className="text-[10.5px] leading-relaxed text-white/35">
          自己造一段 {PROBE_SECONDS} 秒的音频，直接打给你配的识别模型，量一次真实往返。
          不用放视频、也不用声卡 —— 想先知道「换这个模型到底够不够快」的时候用它。
          <br />
          同一个模型不同时刻能差很多倍，所以结果会累积下来 —— 别拿一次的结果下结论。
        </p>

        {probeResult && !probeResult.ok && (
          <div data-perf-probe-result className="rounded-lg bg-danger/12 px-2.5 py-2">
            <p className="text-[10.5px] leading-relaxed text-danger/90">
              {probeResult.message ?? '测速失败'}
            </p>
          </div>
        )}

        {summary.probeSamples > 0 && (
          <div data-perf-probe-result className="rounded-lg bg-ink-800 px-2.5 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] text-white/35">真实往返耗时（最近一次）</span>
              <span className="tnum text-[15px] font-semibold leading-none text-white/90">
                {summary.probeLatest}
                <span className="ml-1 text-[10px] font-normal text-white/40">毫秒</span>
              </span>
            </div>
            <p className="mt-1 text-[9.5px] leading-relaxed text-white/30">
              {PROBE_SECONDS} 秒音频 · 实时率{' '}
              {(summary.probeLatest / PROBE_AUDIO_MS).toFixed(2)} ·{' '}
              {probeResult?.model || '当前识别模型'}
              <br />
              这只是模型 + 网络的耗时，不含采集与切句，真实使用时会更长一点。
            </p>
            {summary.probeSamples >= 2 && (
              <div
                data-perf-probe-spread
                className="mt-1.5 border-t border-line-soft pt-1.5"
              >
                <p className="tnum text-[9.5px] leading-relaxed text-white/40">
                  历次（{summary.probeSamples} 次）：最快 {summary.probeFastest} · 最慢{' '}
                  {summary.probeSlowest} 毫秒 · 实时率最慢{' '}
                  {(summary.probeSlowest / PROBE_AUDIO_MS).toFixed(2)}
                </p>
                <p className="mt-1 text-[9.5px] leading-relaxed text-white/30">
                  决定体验的是最慢的那次：快的时候字幕跟得上，慢的那一次整句话都会卡住。
                </p>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section
        title="最近几轮"
        aside={
          <Button variant="ghost" onClick={() => void clear()} dataAttr="data-perf-clear">
            清空重测
          </Button>
        }
      >
        {recent.length ? (
          recent.map((record) => (
            <div
              key={record.traceId}
              data-perf-row
              className="flex items-center gap-1.5 rounded-lg bg-ink-800/70 px-2 py-1.5"
            >
              <span className="tnum shrink-0 text-[10px] text-white/35" title="这段音频本身多长">
                {ms(record.audioMs)}
              </span>
              <span className="shrink-0 text-[10px] text-white/20">›</span>
              <span
                className="tnum shrink-0 text-[10px] text-accent-soft"
                title="语音识别耗时"
              >
                {ms(record.sttMs)}
              </span>
              <span className="shrink-0 text-[10px] text-white/20">›</span>
              <span className="tnum shrink-0 text-[10px] text-ok" title="翻译耗时">
                {record.translateMs != null ? ms(record.translateMs) : '待译'}
              </span>
              <span className="ml-1 min-w-0 truncate text-[10px] text-white/25">
                {record.speaker === 'foreign' ? '对方' : '你'} · {record.chars} 字
              </span>
            </div>
          ))
        ) : (
          <p className="py-1 text-[10.5px] leading-relaxed text-white/30">
            还没有识别记录。放一段外语视频（真实监听），这里就会逐句记下识别和
            翻译各花了多少毫秒。演示模式播的是内置示例、毫秒就返回，记下来没有
            参考价值，所以刻意不记。现在就想看数字，用上面的「测一次」。
          </p>
        )}
      </Section>

      <p className="mt-1 px-0.5 text-[9.5px] leading-relaxed text-white/25">
        这些数字只存在内存里，关掉软件就没了，不会上传、也不会写进日志文件。
        为了不留对话正文，这里只记「谁说的 · 几个字 · 各段耗时」，不保存句子内容。
      </p>
    </div>
  );
}
