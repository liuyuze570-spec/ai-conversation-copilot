import { IconClose, IconLock, IconMinus, IconPause, IconPlay, IconSettings, IconWave } from './icons';
import type { ListeningStatus } from '../../shared/types';
import {
  captureButtonLabel,
  captureButtonAria,
  captureStatusText,
  captureAnnouncement,
  isCaptureActive,
} from '../../shared/capture-state';

interface Props {
  status: ListeningStatus;
  statusMessage: string;
  alwaysOnTop: boolean;
  locked: boolean;
  onToggleListening: () => void;
  onToggleSettings: () => void;
  onToggleAlwaysOnTop: () => void;
  onToggleLock: () => void;
}

/**
 * 状态文字统一取自 shared/capture-state.ts —— 标题栏、音源条、快捷键
 * 只准读这一份，避免 0.6.2 那种「同一个时刻标题栏写开始采集、音源条写暂停」。
 */
const statusText = (status: ListeningStatus) => captureStatusText(status);

/** 状态点的颜色走语义令牌，不再到处写 emerald/amber/rose。 */
const STATUS_DOT: Record<ListeningStatus, string> = {
  idle: 'bg-white/30',
  starting: 'bg-warn animate-pulse',
  listening: 'bg-ok',
  paused: 'bg-warn',
  'no-audio': 'bg-warn',
  offline: 'bg-danger',
  error: 'bg-danger',
};

export function TitleBar({
  status,
  statusMessage,
  alwaysOnTop,
  locked,
  onToggleListening,
  onToggleSettings,
  onToggleAlwaysOnTop,
  onToggleLock,
}: Props) {
  // 0.6.3：与音源条、快捷键共用 isCaptureActive；no-audio 也是「采集中」。
  const listening = isCaptureActive(status);
  const statusLabel = statusText(status);
  const announcement = captureAnnouncement(status);

  return (
    <div className="drag-region flex items-center gap-2.5 border-b border-line-soft px-3 py-2.5">
      {/* 品牌标记：一个克制的方块 + 声波，比放整行大字更有「产品感」。 */}
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-soft">
        <IconWave size={13} />
      </span>

      <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
        <span className="truncate text-[12.5px] font-semibold tracking-[0.01em] text-white/90">
          AI Conversation Copilot
        </span>
        <span className="flex min-w-0 items-center gap-1.5" title={statusMessage || statusLabel}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden />
          {/* 状态用 live region 播报，但只播「状态」这一句：整条字幕流如果
              也跟着播，读屏会从头到尾念个不停，反而没法用。 */}
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={announcement}
            title={statusMessage || announcement}
            className={`truncate text-[10.5px] ${
              status === 'error' ? 'text-danger/90' : 'text-white/55'
            }`}
          >
            {statusLabel}
          </span>
        </span>
      </div>

      {/* 正在听的时候左侧那条会呼吸，让「它在工作」变得可见。 */}
      {listening && (
        <span className="flex h-3.5 shrink-0 items-center gap-[2px]" aria-hidden>
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="w-[2px] origin-center animate-breathe rounded-full bg-accent-soft/80"
              style={{ height: '100%', animationDelay: `${index * 160}ms` }}
            />
          ))}
        </span>
      )}

      <div className="no-drag flex shrink-0 items-center gap-0.5">
        {/*
          * 0.6.3：标题栏不再放「开始/停止采集」按钮。
          * 它和音源栏的大主按钮、空状态卡片里的「开始监听」指向同一动作，
          * 三个入口让用户不知道该点哪个。现在采集只有一个主入口（音源栏大按钮，
          * 快捷键 Alt+P 仍有效），标题栏只保留窗口控制。
          */}
        {/*
          * 旧版这个按钮的可访问名称只有一个字母「T」（按钮里就写着 T）——
          * 读屏会念「T 按钮」，没人知道它是窗口置顶。现在给完整名称 + 开关状态。
          */}
        <IconButton
          label="窗口置顶"
          hint="窗口置顶，切换后始终显示在其他窗口上面"
          pressed={alwaysOnTop}
          onClick={onToggleAlwaysOnTop}
        >
          <span className="text-[11px] font-bold" aria-hidden>
            T
          </span>
        </IconButton>
        <IconButton
          label="锁定窗口位置"
          hint="锁定窗口位置，防止误拖动"
          pressed={locked}
          onClick={onToggleLock}
        >
          <IconLock />
        </IconButton>
        <IconButton label="打开设置" hint="打开设置" onClick={onToggleSettings}>
          <IconSettings />
        </IconButton>
        <IconButton label="最小化窗口" hint="最小化窗口" onClick={() => window.copilot.minimize()}>
          <IconMinus />
        </IconButton>
        <IconButton
          label="关闭软件"
          hint="关闭软件"
          danger
          onClick={() => {
            window.copilot.setOpacity(1);
            window.copilot.close();
          }}
        >
          <IconClose />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  children,
  label,
  hint,
  onClick,
  active,
  pressed,
  danger,
  tone = 'default',
}: {
  children: React.ReactNode;
  /** 可访问名称：读屏念的就是它，必须说清「这个按钮干什么」。 */
  label: string;
  /** 鼠标悬停提示（可以带上快捷键）。 */
  hint?: string;
  onClick: () => void;
  active?: boolean;
  /** 这是一个开关时，传当前开/关状态，让读屏能念出「已按下 / 未按下」。 */
  pressed?: boolean;
  danger?: boolean;
  tone?: 'default' | 'accent';
}) {
  return (
    <button
      type="button"
      title={hint ?? label}
      aria-label={label}
      {...(typeof pressed === 'boolean' ? { 'aria-pressed': pressed } : {})}
      onClick={onClick}
      className={`no-drag grid h-6 w-6 place-items-center rounded-lg transition-colors duration-150
        ${active ? 'bg-accent/20 text-accent-soft' : ''}
        ${
          tone === 'accent' && !active
            ? 'text-accent-soft/85 hover:bg-accent/15 hover:text-accent-soft'
            : ''
        }
        ${tone === 'default' && !active ? 'text-white/50 hover:bg-ink-700 hover:text-white' : ''}
        ${active ? 'hover:bg-accent/25' : ''}
        ${danger ? 'hover:bg-danger/20 hover:text-danger' : ''}`}
    >
      {children}
    </button>
  );
}
