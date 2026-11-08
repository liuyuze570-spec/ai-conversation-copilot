/**
 * 网页的纯逻辑层：把「原文 + 译文」变成可核对的事实卡与一句确认。
 *
 * 全部复用桌面端已经验证过的规则（`@shared/facts`），不另写一套 —— 否则
 * 同一个句子在 App 和网页上给出两种确认句，是最难解释的 bug。
 */
import {
  FACT_LABELS,
  deriveSpoken,
  extractFactsWithRules,
  planConfirmSentence,
  type ConfirmPlan,
  type FactDraft,
  type FactKind,
} from '@shared/facts';
import { buildHintPlan, type HintPlan } from '@services/pronunciation';
import type { HintSystem } from '@shared/languages';

export interface FactRow {
  id: string;
  kind: FactKind;
  label: string;
  /** 展示用：中文（合并后取自译文）。 */
  value: string;
  /** 对方原话里的片段，用来核对「他到底怎么说的」。 */
  sourceText: string;
  negated: boolean;
  certainty: 'stated' | 'uncertain' | 'corrected';
  checked: boolean;
  edited: boolean;
  originalValue?: string;
  /** 用户自己写的目标语言说法（改过值又推不出时用）。 */
  spoken?: string;
}

let seq = 0;

export function rowsFromDrafts(drafts: FactDraft[]): FactRow[] {
  return drafts.map((draft) => {
    seq += 1;
    return {
      id: `web-fact-${seq}`,
      kind: draft.kind,
      label: FACT_LABELS[draft.kind] ?? draft.kind,
      value: draft.value,
      sourceText: draft.sourceText,
      negated: Boolean(draft.negated),
      certainty: draft.certainty,
      // 默认勾选「当前理解、且没被否定」的，旧的否定值不预选。
      checked: !draft.negated,
      edited: false,
    };
  });
}

export function analyze(originalText: string, translatedText: string): FactRow[] {
  return rowsFromDrafts(
    extractFactsWithRules({ originalText, translatedText: translatedText ?? '' }),
  );
}

/** 改值：保留原话、记录改前值，并清掉旧说法（旧说法对应旧值，不能再用）。 */
export function editRow(rows: FactRow[], id: string, value: string): FactRow[] {
  return rows.map((row) => {
    if (row.id !== id) return row;
    const next = value.trim();
    if (!next || next === row.value) return row;
    return {
      ...row,
      value: next,
      edited: true,
      originalValue: row.originalValue ?? row.value,
      spoken: undefined,
      certainty: 'stated',
      checked: true,
      negated: false,
    };
  });
}

export function setSpoken(rows: FactRow[], id: string, spoken: string): FactRow[] {
  return rows.map((row) => (row.id === id ? { ...row, spoken: spoken.trim() || undefined } : row));
}

export function toggleRow(rows: FactRow[], id: string): FactRow[] {
  return rows.map((row) => (row.id === id ? { ...row, checked: !row.checked } : row));
}

/** 这一行改了值、但推不出目标语言说法 —— 界面要提示「需补说法」。 */
export function needsWording(row: FactRow): boolean {
  if (!row.edited || row.spoken) return false;
  return !deriveSpoken(
    { value: row.value, sourceText: row.sourceText, edited: true, originalValue: row.originalValue },
    'English',
  ).ok;
}

export function confirm(rows: FactRow[]): ConfirmPlan {
  const picked = rows.filter((row) => row.checked);
  return planConfirmSentence(
    picked.map((row) => ({
      id: row.id,
      kind: row.kind,
      value: row.value,
      sourceText: row.sourceText,
      edited: row.edited,
      originalValue: row.originalValue,
      spoken: row.spoken,
      spokenSource: row.spoken ? 'user' : undefined,
      negated: row.negated,
      certainty: row.certainty,
    })),
    'English',
    'Chinese',
  );
}

/** 读音提示：网页只做中文用户的汉字近音，不冒充多语言能力。 */
export function hintsFor(text: string, system: HintSystem = 'hanzi'): HintPlan | null {
  if (!text.trim()) return null;
  try {
    return buildHintPlan(text, 'English', system, []);
  } catch {
    return null;
  }
}

/** 预置样例一律经这里标记，界面据此显示「预置演示」徽标。 */
export const PRESET_BADGE = '预置演示';
export const REAL_BADGE = '真实翻译';
