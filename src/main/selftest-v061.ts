import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logger } from './logger';
import { getSettingsStore } from './settings-store';
import { getHistoryStore } from './history-db';
import type { HistoryMessage } from '../shared/history';

/**
 * 「真的把整个程序退掉，再启动」的跨进程一致性检查。
 *
 * ## 为什么单独做一个
 *
 * 0.6.0 的自检（`selftest-v060.ts`）最后一步是把库关掉再打开 —— 那证明的是
 * 「数据落盘了」，**不是**「退出进程后还在」。两者差别很实在：真实退出会走
 * `will-quit` / `before-quit` 的收尾（关库、刷设置），而 `win.reload()` 什么都不走。
 * 之前的交付文档里把这件事标成「部分执行」，现在把它补齐。
 *
 * ## 怎么跑
 *
 * 同一个 `--user-data-dir` 起**两次进程**：
 *  1. `COPILOT_V061=write`：改字号、改语言方向、写 3 条记录 + 2 条事实，
 *     写 `v061-write.json`，然后 `app.quit()`（走真实退出流程）；
 *  2. `COPILOT_V061=read`：新进程读回设置与记录，逐项比对，写 `v061-read.json`。
 *
 * 比对结果里 `checks` 每一条都是「期望 / 实际」，不是一句「通过」。
 */
type Phase = 'write' | 'read';

const SESSION_ID = 'v061-restart';
const FONT = { originalFontSize: 21, translationFontSize: 27, romanizationFontSize: 15 };

function reportPath(dir: string, phase: Phase): string {
  return path.join(dir, `v061-${phase}.json`);
}

function writeReport(dir: string, phase: Phase, data: unknown) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(reportPath(dir, phase), JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    logger.warn('RestartCheck', `write report failed: ${String(error).slice(0, 60)}`);
  }
}

function sampleMessages(): HistoryMessage[] {
  const base = {
    sessionId: SESSION_ID,
    speaker: 'foreign' as const,
    source: 'system' as const,
    state: 'final' as const,
    confidence: 0.95,
    edited: false,
  };
  return [
    {
      ...base,
      id: 'v061-m1',
      seq: 1,
      ts: 1_760_000_000_000,
      original: 'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
      translation: '会議は火曜日ではありません。木曜日の午前10時30分に変更になりました。',
      romanization: 'ザ ミーティング イズ ノット オン チューズデイ',
      hintSystem: 'katakana',
      hintVersion: 2,
      comprehension: 'Japanese',
      reply: 'Just to confirm, Thursday at 10:30 a.m. Is that right?',
    },
    {
      ...base,
      id: 'v061-m2',
      seq: 2,
      ts: 1_760_000_001_000,
      original: 'The budget is fifteen thousand, not fifty thousand.',
      translation: '予算は1万5千で、5万ではありません。',
      romanization: '',
      hintSystem: 'katakana',
      hintVersion: 2,
      comprehension: 'Japanese',
    },
    {
      ...base,
      id: 'v061-m3',
      seq: 3,
      ts: 1_760_000_002_000,
      original: 'Please send the report by 3 p.m. tomorrow.',
      translation: '明日の午後3時までにレポートを送ってください。',
      romanization: 'プリーズ センド ザ レポート バイ スリー ピーエム トゥモロー',
      hintSystem: 'katakana',
      hintVersion: 2,
      comprehension: 'Japanese',
      reply: 'Sure, I will send it by 3 p.m. tomorrow.',
    },
  ];
}

export async function runV061RestartCheck(): Promise<void> {
  const raw = process.env.COPILOT_V061;
  const dir = process.env.COPILOT_V061_DIR;
  if (!raw || !dir) return;
  const phase = raw === 'read' ? 'read' : 'write';

  const finish = (data: unknown) => {
    writeReport(dir, phase, data);
    logger.info('RestartCheck', `${phase} done`);
    // 走真实退出：main 的 will-quit 会关库、刷设置。
    setTimeout(() => app.quit(), 300);
  };

  try {
    if (phase === 'write') {
      const settings = getSettingsStore();
      settings.update({ ...FONT, nativeLanguage: 'Japanese', hintSystem: 'katakana', accent: 'en-GB' } as never);

      const store = getHistoryStore();
      store.ensureSession({
        id: SESSION_ID,
        language: 'English',
        scenario: 'conversation',
        sourceMode: 'system',
        comprehension: 'Japanese',
        hintSystem: 'katakana',
      } as never);
      const messages = sampleMessages();
      store.upsertMessages(SESSION_ID, messages);
      store.saveFacts(SESSION_ID, [
        {
          id: 'v061-f1',
          sessionId: SESSION_ID,
          messageId: 'v061-m1',
          kind: 'date',
          value: '木曜日',
          sourceText: 'Thursday',
          certainty: 'stated',
          confirmed: true,
          edited: false,
          createdAt: 1_760_000_000_500,
        },
        {
          id: 'v061-f2',
          sessionId: SESSION_ID,
          messageId: 'v061-m1',
          kind: 'date',
          value: '火曜日',
          sourceText: 'Tuesday',
          certainty: 'corrected',
          negated: true,
          confirmed: false,
          edited: false,
          createdAt: 1_760_000_000_600,
        },
        // 用户改过值 + 自己补过说法 + 有完整的修改 / 确认 / 取消确认轨迹
        {
          id: 'v061-f3',
          sessionId: SESSION_ID,
          messageId: 'v061-m1',
          kind: 'money',
          value: '16000美元',
          sourceText: '15,000 dollars',
          certainty: 'stated',
          edited: true,
          originalValue: '15000美元',
          status: 'pending',
          spoken: '16,000 dollars',
          spokenSource: 'user',
          sourceField: 'original',
          comprehension: 'Japanese',
          targetLanguage: 'English',
          hintSystem: 'katakana',
          createdAt: 1_760_000_000_700,
          log: [
            { at: 1_760_000_000_800, action: 'edited', from: '15000美元', to: '16000美元' },
            { at: 1_760_000_000_900, action: 'confirmed' },
            { at: 1_760_000_001_000, action: 'unconfirmed' },
          ],
        },
      ]);

      finish({
        phase,
        sessionId: SESSION_ID,
        wrote: messages.length,
        pid: process.pid,
        at: new Date().toISOString(),
      });
      return;
    }

    // ---- read ----
    const settings = getSettingsStore().get() as unknown as Record<string, number | string>;
    const store = getHistoryStore();
    const page = store.getPage(SESSION_ID, { limit: 20 });
    const byId = new Map(page.messages.map((message) => [message.id, message]));
    const facts = store.getFacts(SESSION_ID);
    const confirmed = facts.find((fact) => fact.id === 'v061-f1');
    const corrected = facts.find((fact) => fact.id === 'v061-f2');
    const editedFact = facts.find((fact) => fact.id === 'v061-f3');

    const checks: { name: string; want: unknown; got: unknown; ok: boolean }[] = [];
    const check = (name: string, want: unknown, got: unknown) => {
      checks.push({ name, want, got, ok: JSON.stringify(want) === JSON.stringify(got) });
    };

    check('字号·原文', FONT.originalFontSize, settings.originalFontSize);
    check('字号·译文', FONT.translationFontSize, settings.translationFontSize);
    check('字号·提示', FONT.romanizationFontSize, settings.romanizationFontSize);
    check('理解语言', 'Japanese', settings.nativeLanguage);
    check('提示体系', 'katakana', settings.hintSystem);
    check('口音', 'en-GB', settings.accent);
    check('记录条数', 3, page.messages.length);
    check('第 1 条原文', sampleMessages()[0].original, byId.get('v061-m1')?.original);
    check('第 1 条回复', sampleMessages()[0].reply, byId.get('v061-m1')?.reply);
    check('第 1 条提示体系', 'katakana', byId.get('v061-m1')?.hintSystem);
    check('第 2 条译文', sampleMessages()[1].translation, byId.get('v061-m2')?.translation);
    check('第 3 条回复', sampleMessages()[2].reply, byId.get('v061-m3')?.reply);
    check('seq 连续（分页游标）', [1, 2, 3], page.messages.map((m) => m.seq).sort((a, b) => a - b));
    check('事实·已确认', true, confirmed?.confirmed);
    check('事实·被否定关系', 'corrected', corrected?.certainty);
    check('事实·否定标记', true, corrected?.negated);
    check('事实·改后的值', '16000美元', editedFact?.value);
    check('事实·改前的值', '15000美元', editedFact?.originalValue);
    check('事实·现在的说法', '16,000 dollars', editedFact?.spoken);
    check('事实·说法来源', 'user', editedFact?.spokenSource);
    check('事实·修改轨迹条数', 3, editedFact?.log?.length);
    check('事实·轨迹第一条', '15000美元', editedFact?.log?.[0]?.from);
    check('事实·理解语言', 'Japanese', editedFact?.comprehension);
    check('事实·否定标记', true, corrected?.negated);
    finish({
      phase,
      pid: process.pid,
      at: new Date().toISOString(),
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
      checks,
    });
  } catch (error) {
    writeReport(dir, phase, {
      phase,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    logger.error('RestartCheck', `failed: ${String(error).slice(0, 80)}`);
    setTimeout(() => app.quit(), 300);
  }
}
