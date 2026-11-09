import { useEffect, useState } from 'react';
import type { HealthReport } from '../../shared/health';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';
import { HealthView } from './HealthView';

/**
 * Why is the subtitle list empty?
 *
 * 四个可能的原因（演示模式 / 没开始听 / 采集出错 / 听到但没声音）看起来一模一样，
 * 所以这个面板负责把它们区分开，并给出唯一有效的那一个动作。
 *
 * 关于「诊断结果」的分工（用户明确要求）：
 * - **没点「一键诊断」时，一条检查结果都不显示**。以前一进空态就摆设备名、采样率、
 *   dB、rms 和四条排查清单，用户既看不懂，也分不清哪一条真的挡着字幕。
 * - 点了之后才跑全套体检，而且**只显示有问题的项**；全都正常就一行结论。
 */
export function AudioDiagnostics({ onListen }: { onListen: () => void }) {
  const status = useUiStore((state) => state.status);
  const statusMessage = useUiStore((state) => state.statusMessage);
  const level = useUiStore((state) => state.level);
  const heardAt = useUiStore((state) => state.heardAt);
  const settings = useSettingsStore((state) => state.settings);
  const toggleSettings = useUiStore((state) => state.toggleSettings);

  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [checking, setChecking] = useState(false);

  // `heardAt` ages out on a timer, and timers are not reactive — tick once a
  // second so the panel can move from "waiting" back to "nothing heard".
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.copilot
      .aiKeyInfo()
      // 字幕能不能出，取决于「语音识别」有没有可用的 Key。
      .then((info) => {
        if (alive) setHasKey(info.sttReady);
      })
      .catch(() => {
        if (alive) setHasKey(false);
      });
    return () => {
      alive = false;
    };
  }, [status, settings.mockMode]);

  const runCheck = async () => {
    setChecking(true);
    try {
      setReport(await window.copilot.systemCheck());
    } finally {
      setChecking(false);
    }
  };

  // ---- 1. demo mode: cannot hear the computer at all ---------------------
  if (settings.mockMode) {
    return (
      <Shell tone="warn" title="当前是演示模式，听不到电脑里的声音">
        演示模式只会播放内置的示例对话，不采集扬声器。要看电影 / 网课 / 任何软件的声音，
        请切到真实监听。
        <Actions>
          <Primary onClick={onListen}>开始监听系统声音</Primary>
          <Ghost onClick={() => toggleSettings(true)}>打开设置</Ghost>
        </Actions>
      </Shell>
    );
  }

  // ---- 2. not listening yet ---------------------------------------------
  if (status === 'idle' || status === 'paused') {
    return (
      <Shell tone="neutral" title="还没有开始监听">
        点上方蓝色「开始采集」按钮，就能听到<strong className="font-medium text-white/75">任何软件</strong>正在播放的内容——
        浏览器、哔哩哔哩、播放器、会议、网课都一样。
      </Shell>
    );
  }

  // ---- 3. hard failure from the sidecar ---------------------------------
  if (status === 'error') {
    return (
      <Shell tone="danger" title="音频采集出错">
        {statusMessage || '音频管线启动失败。'}
        <Actions>
          <Primary onClick={onListen}>重试</Primary>
          <Ghost onClick={() => toggleSettings(true)}>打开设置</Ghost>
        </Actions>
      </Shell>
    );
  }

  // ---- 4. listening: signal or not? -------------------------------------
  // Use "did we ever hear something recently" rather than the instantaneous
  // level: gaps between sentences are normal and must not flip the panel.
  const db = level?.db ?? -120;
  const heardRecently = heardAt > 0 && Date.now() - heardAt < 20000;

  if (!heardRecently) {
    return (
      <Shell tone="warn" title="正在监听，但暂时没听到声音">
        设备已经打开。如果视频正在播放还是没有动静，让它自己查一遍 ——
        会把音频组件、默认扬声器、采集开关、Key 和模型都看一遍，只告诉你哪一项挡着。
        {report && (
          <div className="mt-2">
            <HealthView report={report} />
          </div>
        )}
        <Actions>
          <Primary onClick={() => void runCheck()} disabled={checking} dataAttr="data-health-run">
            {checking ? '正在检查…' : '一键诊断'}
          </Primary>
          <Ghost onClick={() => toggleSettings(true)}>打开设置</Ghost>
        </Actions>
      </Shell>
    );
  }

  // ---- 5. audio is arriving, so the problem is recognition --------------
  return (
    <Shell tone="accent" title="已经听到声音了，正在等待字幕">
      {hasKey === false
        ? '声音采集正常，只差一个「语音识别 Key」。跟着 3 分钟图文教程走一遍就能出字幕，全程免费。'
        : '声音已经进来，识别需要几秒钟。如果几十秒都没有文字，问题多半不在音频 —— 点「一键诊断」，它会把 Key 余额、模型和采集一起查一遍。'}
      <div className="mt-1 font-mono text-[10px] text-white/35">
        已捕获 {level?.capturedSeconds.toFixed(0)} 秒 ·{' '}
        {db > -95 ? `当前 ${db.toFixed(0)}dB` : '当前静音（刚才是听到过的）'}
      </div>
      {/* 这一支也要能诊断：最常见的情况正是「声音进来了但一句字幕都没有」
          （比如账户余额用光），这时候不给入口，用户只能干等。 */}
      {report && (
        <div className="mt-2">
          <HealthView report={report} />
        </div>
      )}
      <Actions>
        <Primary onClick={() => void runCheck()} disabled={checking} dataAttr="data-health-run">
          {checking ? '正在检查…' : '一键诊断'}
        </Primary>
        {hasKey === false && (
          <Ghost onClick={() => toggleSettings(true)}>去填 API Key</Ghost>
        )}
        {hasKey === false && (
          <Ghost onClick={() => void window.copilot.openDoc('tutorial')}>看新手教程</Ghost>
        )}
      </Actions>
    </Shell>
  );
}

function Shell({
  tone,
  title,
  children,
}: {
  tone: 'neutral' | 'warn' | 'danger' | 'accent';
  title: string;
  children: React.ReactNode;
}) {
  const dot: Record<'neutral' | 'warn' | 'danger' | 'accent', string> = {
    neutral: 'bg-white/35',
    warn: 'bg-warn',
    danger: 'bg-danger',
    accent: 'bg-accent',
  };
  return (
    <div data-audio-diagnostics className="flex flex-1 flex-col justify-center px-3.5 py-3">
      <div className="rounded-2xl border border-line-soft bg-ink-850 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${dot[tone]}`} />
          <span className="text-[12px] font-medium text-white/85">{title}</span>
        </div>
        <div className="mt-2 text-[11.5px] leading-relaxed text-white/50">{children}</div>
      </div>
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2.5 flex flex-wrap gap-1.5">{children}</div>;
}

function Primary({
  children,
  onClick,
  disabled,
  dataAttr,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** 完整属性名（例如 data-health-run），不要传短名。 */
  dataAttr?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      {...(dataAttr ? { [dataAttr]: '' } : {})}
      className="no-drag rounded-lg bg-accent px-2.5 py-1.5 text-[11.5px] font-semibold text-white
        transition-colors duration-150 hover:bg-accent-dim disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function Ghost({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="no-drag rounded-lg border border-line px-2.5 py-1.5 text-[11.5px] text-white/55
        transition-colors duration-150 hover:bg-ink-700 hover:text-white"
    >
      {children}
    </button>
  );
}
