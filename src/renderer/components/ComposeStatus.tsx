import { useUiStore } from '../stores/ui';

/**
 * 「中文 → 外语」的常驻状态条（0.6.3）。
 *
 * 为什么单独做成组件、放在 App 里而不是塞在 QuickActions 的「更多」面板中：
 * 0.6.2 提交后立刻清空输入框，失败时错误只出现在 ReplyPanel，而用户把
 * 「更多」收起、切到紧凑模式、或者放大字号之后，那块面板可能根本不在
 * 可视区域 —— 表现为「点了没反应，字也没了」。状态条是常显的、shrink-0，
 * 且用 aria-live 播报，三种窗口形态下都能看到/听到。
 *
 * 它显示的是**状态**，不重复展示回复正文（回复卡在 ReplyPanel）。
 */
export function ComposeStatus({
  onRetry,
  onClear,
}: {
  onRetry: (chinese: string) => void;
  onClear: () => void;
}) {
  const compose = useUiStore((state) => state.compose);
  if (compose.phase === 'idle') return null;

  const pending = compose.phase === 'pending';
  const failed = compose.phase === 'error';
  const draft = compose.submitted || compose.draft;
  const summary = draft.length > 34 ? `${draft.slice(0, 34)}…` : draft;

  const title = pending
    ? '正在把中文转成外语…'
    : failed
      ? '没能生成外语回复'
      : `已生成 ${compose.resultCount} 条外语回复，见下方回复卡`;

  return (
    <div
      id="compose-status"
      data-compose-status
      data-compose-phase={compose.phase}
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`shrink-0 border-t px-3.5 py-2 text-[11px] leading-relaxed ${
        failed
          ? 'border-danger/30 bg-danger/[0.07] text-danger'
          : pending
            ? 'border-warn/25 bg-warn/[0.06] text-warn'
            : 'border-ok/25 bg-ok/[0.06] text-ok'
      }`}
    >
      <p className="font-semibold">{title}</p>
      {draft && (
        <p className="mt-0.5 break-words text-white/70">
          原句：{summary}
          {pending && <span className="ml-1 text-white/45">（已保留，不会丢失）</span>}
          {failed && <span className="ml-1 text-white/45">（草稿已保留）</span>}
        </p>
      )}
      {failed && compose.error && (
        <p className="mt-0.5 break-words text-white/65">{compose.error}</p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {!pending && draft && (
          <button
            type="button"
            data-compose-retry
            onClick={() => onRetry(draft)}
            className="no-drag rounded-lg border border-line bg-ink-850 px-2 py-1 text-[10.5px]
              font-semibold text-white/85 hover:bg-ink-800"
          >
            {failed ? '重试这一句' : '再生成一次'}
          </button>
        )}
        <button
          type="button"
          data-compose-clear
          onClick={onClear}
          className="no-drag rounded-lg border border-line-soft px-2 py-1 text-[10.5px]
            text-white/60 hover:bg-ink-850 hover:text-white/85"
        >
          清除草稿
        </button>
      </div>
    </div>
  );
}
