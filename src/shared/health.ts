/**
 * 「一键诊断」的结果模型。
 *
 * 设计原则（用户明确要求）：**没点按钮不显示任何检查结果；点了之后只显示有问题的
 * 项**。以前的做法是一进空态就摆一堆技术参数（设备名、采样率、dB、rms），用户既
 * 看不懂，也分不清哪一项才真的挡着字幕。
 *
 * 所以这里不返回「一段字符串」，而是返回结构化条目：UI 自己筛掉 `ok`，只把
 * `warn` / `fail` 连同「怎么办」一起显示出来。
 */

export type HealthLevel = 'ok' | 'warn' | 'fail';

export interface HealthItem {
  /** 稳定 id，便于单测与界面 diff。 */
  id: string;
  level: HealthLevel;
  /** 一句话说清是什么情况（用户能看懂，不要写 dB / rms）。 */
  title: string;
  /** 补充细节，可省略。 */
  detail?: string;
  /** 怎么办。只有出问题时才需要。 */
  fix?: string;
}

export interface HealthReport {
  checkedAt: number;
  items: HealthItem[];
}

/**
 * 只留下用户需要看的项。
 *
 * 这一条是「没问题不用显示出来」的直接实现：`ok` 的项目在界面上一个都不出现，
 * 它们只用来让全绿时能收敛成一句「检查完成，没有发现问题」。
 */
export function visibleIssues(items: HealthItem[]): HealthItem[] {
  return items.filter((item) => item.level !== 'ok');
}

export interface HealthSummary {
  /** 没有需要处理的项。 */
  ok: boolean;
  failed: number;
  warned: number;
  /** 界面上那行大字。 */
  headline: string;
  /** 副标题，全绿时为空。 */
  detail: string;
}

export function healthSummary(report: HealthReport | null): HealthSummary {
  if (!report) {
    return { ok: true, failed: 0, warned: 0, headline: '还没有检查', detail: '' };
  }
  const issues = visibleIssues(report.items);
  const failed = issues.filter((item) => item.level === 'fail').length;
  const warned = issues.filter((item) => item.level === 'warn').length;

  if (failed > 0) {
    return {
      ok: false,
      failed,
      warned,
      // 有建议也一并说出来，否则「发现 1 个问题」下面却列着两条，看起来像数错了。
      headline: warned > 0 ? `发现 ${failed} 个问题、${warned} 条建议` : `发现 ${failed} 个问题`,
      detail: '按下面每一条的建议处理，处理完再点一次诊断。',
    };
  }
  if (warned > 0) {
    return {
      ok: true,
      failed,
      warned,
      headline: `能用，但有 ${warned} 条建议`,
      detail: '不影响出字幕，有空再调。',
    };
  }
  return { ok: true, failed: 0, warned: 0, headline: '检查完成，没有发现问题', detail: '' };
}
