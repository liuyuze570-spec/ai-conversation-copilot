import { dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import { describeHistoryError, type HistoryFact, type HistoryMessage } from '../shared/history';
import type { ScenarioMode, TargetLanguage } from '../shared/types';
import type { SourceMode } from '../shared/sources';
import { getHistoryStore, hasHistoryStore, initHistoryStore } from './history-db';
import { logger } from './logger';

/**
 * 聊天记录的 IPC 层。
 *
 * 规矩只有一条：**任何失败都必须回结构化结果，不许抛裸异常、不许回空值**。
 * 界面要靠 `code` 决定是「磁盘满」还是「文件被占用」，两种情况给用户的
 * 下一步动作完全不同；回一个空字符串等于什么都不说。
 */

type Ok<T> = { ok: true; data: T };
type Fail = { ok: false; error: ReturnType<typeof describeHistoryError> };
type Result<T> = Ok<T> | Fail;

function fail(error: unknown): Fail {
  const info = (error as { historyError?: ReturnType<typeof describeHistoryError> })
    ?.historyError;
  const described = info ?? describeHistoryError(error);
  // 日志只留错误码：正文、标题、用户说的话一律不进 app.log。
  logger.error('History', `operation failed: ${described.code}`);
  return { ok: false, error: described };
}

function wrap<T>(fn: () => T): Result<T> {
  if (!hasHistoryStore()) {
    return {
      ok: false,
      error: {
        code: 'not-ready',
        title: '记录功能还没准备好',
        hint: '重启一次软件；如果仍然这样，说明记录文件打不开，请把用户数据目录里的 history.db 备份后重命名再试。',
      },
    };
  }
  try {
    return { ok: true, data: fn() };
  } catch (error) {
    return fail(error);
  }
}

/** 导出 / 备份要弹系统对话框，是异步的 —— 单独一个包装，规则同上。 */
async function wrapAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
  if (!hasHistoryStore()) {
    return {
      ok: false,
      error: {
        code: 'not-ready',
        title: '记录功能还没准备好',
        hint: '重启一次软件；如果仍然这样，说明记录文件打不开，请把用户数据目录里的 history.db 备份后重命名再试。',
      },
    };
  }
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return fail(error);
  }
}

export function registerHistoryIpc(win: BrowserWindow, userDataDir: string) {
  const initial = initHistoryStore(userDataDir);
  if (!initial.ready) {
    logger.warn('History', `history disabled: ${initial.lastError || 'unknown'}`);
  }

  ipcMain.handle(IPC.HISTORY_STATUS, async () => wrap(() => getHistoryStore().status()));

  ipcMain.handle(
    IPC.HISTORY_ENSURE_SESSION,
    async (
      _event,
      payload: {
        id: string;
        language: TargetLanguage;
        scenario: ScenarioMode;
        sourceMode: SourceMode;
        comprehension?: string;
        hintSystem?: string;
      },
    ) =>
      wrap(() =>
        getHistoryStore().ensureSession({
          id: String(payload.id),
          language: payload.language,
          scenario: payload.scenario,
          sourceMode: payload.sourceMode,
          comprehension: payload.comprehension,
          hintSystem: payload.hintSystem,
        }),
      ),
  );

  ipcMain.handle(
    IPC.HISTORY_UPSERT,
    async (_event, payload: { sessionId: string; messages: HistoryMessage[] }) =>
      wrap(() =>
        getHistoryStore().upsertMessages(
          String(payload.sessionId),
          Array.isArray(payload.messages) ? payload.messages : [],
        ),
      ),
  );

  ipcMain.handle(
    IPC.HISTORY_SAVE_FACTS,
    async (_event, payload: { sessionId: string; facts: HistoryFact[]; removedIds?: string[] }) =>
      wrap(() => {
        getHistoryStore().saveFacts(
          String(payload.sessionId),
          Array.isArray(payload.facts) ? payload.facts : [],
          Array.isArray(payload.removedIds) ? payload.removedIds.map(String) : [],
        );
        return { written: payload.facts?.length ?? 0 };
      }),
  );

  ipcMain.handle(
    IPC.HISTORY_LIST,
    async (_event, payload: { limit?: number; offset?: number } = {}) =>
      wrap(() => getHistoryStore().listSessions({ limit: payload.limit, offset: payload.offset })),
  );

  ipcMain.handle(
    IPC.HISTORY_PAGE,
    async (_event, payload: { sessionId: string; beforeSeq?: number | null; limit?: number }) =>
      wrap(() =>
        getHistoryStore().getPage(String(payload.sessionId), {
          beforeSeq: payload.beforeSeq ?? null,
          limit: payload.limit,
        }),
      ),
  );

  ipcMain.handle(
    IPC.HISTORY_SEARCH,
    async (_event, payload: { query: string; limit?: number }) =>
      wrap(() => getHistoryStore().search(String(payload.query ?? ''), { limit: payload.limit })),
  );

  ipcMain.handle(IPC.HISTORY_RENAME, async (_event, payload: { id: string; title: string }) =>
    wrap(() => {
      getHistoryStore().renameSession(String(payload.id), String(payload.title ?? ''));
      return { ok: true };
    }),
  );

  ipcMain.handle(IPC.HISTORY_DELETE, async (_event, payload: { id: string }) =>
    wrap(() => {
      getHistoryStore().deleteSession(String(payload.id));
      return { ok: true };
    }),
  );

  ipcMain.handle(IPC.HISTORY_CLEAR, async () => wrap(() => getHistoryStore().clearAll()));

  /**
   * 导出。`format=text` 是可读文本（默认），`format=json` 是结构化备份。
   *
   * 用系统「另存为」对话框而不是自己拼路径：用户能直接看到文件存哪了。
   * 大量记录按会话分批写，不把全部内容攒在内存里。
   */
  ipcMain.handle(
    IPC.HISTORY_EXPORT,
    async (
      _event,
      payload: { sessionId?: string; format?: 'text' | 'json' } = {},
    ) =>
      wrapAsync(async () => {
        const format = payload.format === 'json' ? 'json' : 'text';
        const store = getHistoryStore();
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, 19);
        const defaultName = payload.sessionId
          ? `对话记录-${stamp}.${format === 'json' ? 'json' : 'txt'}`
          : `对话记录-全部-${stamp}.${format === 'json' ? 'json' : 'txt'}`;
        const picked = await dialog.showSaveDialog(win, {
          title: '导出对话记录',
          defaultPath: path.join(userDataDir, defaultName),
          filters:
            format === 'json'
              ? [{ name: '结构化备份', extensions: ['json'] }]
              : [{ name: '文本文件', extensions: ['txt'] }],
        });
        if (picked.canceled || !picked.filePath) {
          return { canceled: true as const, path: '', sessions: 0, messages: 0, bytes: 0 };
        }

        if (format === 'json') {
          const result = store.exportJson(picked.filePath);
          const bytes = fs.statSync(picked.filePath).size;
          logger.info(
            'History',
            `exported json sessions=${result.sessions} messages=${result.messages}`,
          );
          return { canceled: false as const, path: picked.filePath, ...result, bytes };
        }

        if (payload.sessionId) {
          const result = store.exportSessionText(String(payload.sessionId), picked.filePath);
          const bytes = fs.statSync(picked.filePath).size;
          logger.info('History', `exported session messages=${result.messages}`);
          return {
            canceled: false as const,
            path: picked.filePath,
            sessions: 1,
            messages: result.messages,
            bytes,
          };
        }

        // 全部会话：一个文本文件，按会话分段、按批追加。
        fs.writeFileSync(picked.filePath, '', 'utf8');
        let sessions = 0;
        let messages = 0;
        let offset = 0;
        for (;;) {
          const page = store.listSessions({ limit: 20, offset });
          if (!page.items.length) break;
          for (const session of page.items) {
            const one = store.exportSessionText(session.id, `${picked.filePath}.tmp`);
            const chunk = fs.readFileSync(`${picked.filePath}.tmp`, 'utf8');
            fs.appendFileSync(picked.filePath, `${chunk}\n\n---\n\n`, 'utf8');
            sessions += 1;
            messages += one.messages;
          }
          offset += page.items.length;
        }
        try {
          fs.unlinkSync(`${picked.filePath}.tmp`);
        } catch {
          /* 临时文件可能已经不在了 */
        }
        const bytes = fs.statSync(picked.filePath).size;
        logger.info('History', `exported all sessions=${sessions} messages=${messages}`);
        return { canceled: false as const, path: picked.filePath, sessions, messages, bytes };
      }),
  );

  ipcMain.handle(IPC.HISTORY_BACKUP, async () =>
    wrapAsync(async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const picked = await dialog.showSaveDialog(win, {
        title: '备份记录数据库',
        defaultPath: path.join(userDataDir, `history-backup-${stamp}.db`),
        filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
      });
      if (picked.canceled || !picked.filePath) {
        return { canceled: true as const, path: '', bytes: 0 };
      }
      const result = getHistoryStore().backupTo(picked.filePath);
      logger.info('History', `backup written bytes=${result.bytes}`);
      return { canceled: false as const, path: picked.filePath, bytes: result.bytes };
    }),
  );

  ipcMain.handle(IPC.HISTORY_OPEN_FOLDER, async () =>
    wrapAsync(async () => {
      await shell.openPath(userDataDir);
      return { ok: true, dir: userDataDir };
    }),
  );
}
