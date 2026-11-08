import { healthSummary, visibleIssues, type HealthItem, type HealthReport } from '../../shared/health';

/**
 * 体检报告。
 *
 * 只显示**有问题**的项：全绿时收敛成一行，有一堆 `ok` 也不列出来 —— 用户要的是
 * 「哪里挡着出字幕」，不是一份设备参数清单。这跟「一键诊断」按钮的分工是：
 * 没点按钮 = 什么都不显示；点了 = 只显示要处理的。
 */
export function HealthView({ report }: { report: HealthReport }) {
  const summary = healthSummary(report);
  const issues = visibleIssues(report.items);

  if (!issues.length) {
    return (
      <div
        data-health-report
        data-health-ok
        className="flex items-center gap-1.5 rounded-lg border border-ok/25 bg-ok/10 px-2 py-1.5 text-[10.5px] text-ok/90"
      >
        <span className="text-[11px] leading-none">✓</span>
        <span>{summary.headline}</span>
      </div>
    );
  }

  return (
    <div data-health-report className="space-y-1.5">
      <div
        className={`rounded-lg px-2 py-1.5 text-[10.5px] font-medium ${
          summary.failed > 0 ? 'bg-danger/12 text-danger/90' : 'bg-warn/12 text-warn/90'
        }`}
      >
        {summary.headline}
        {summary.detail && (
          <span className="ml-1 font-normal opacity-70">{summary.detail}</span>
        )}
      </div>
      {issues.map((item) => (
        <IssueRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function IssueRow({ item }: { item: HealthItem }) {
  const tone =
    item.level === 'fail'
      ? { dot: 'bg-danger', title: 'text-danger/90', box: 'border-danger/25' }
      : { dot: 'bg-warn', title: 'text-warn/90', box: 'border-warn/25' };

  return (
    <div
      data-health-item={item.id}
      data-health-level={item.level}
      className={`rounded-lg border ${tone.box} bg-ink-800 px-2 py-1.5`}
    >
      <div className="flex items-start gap-1.5">
        <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
        <div className="min-w-0">
          <p className={`text-[11px] font-medium leading-snug ${tone.title}`}>{item.title}</p>
          {item.detail && (
            <p className="mt-0.5 text-[10px] leading-relaxed text-white/40">{item.detail}</p>
          )}
          {item.fix && (
            <p className="mt-0.5 text-[10px] leading-relaxed text-white/55">→ {item.fix}</p>
          )}
        </div>
      </div>
    </div>
  );
}
