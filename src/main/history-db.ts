import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'node-sqlite3-wasm';
import { logger } from './logger';
import {
  describeHistoryError,
  deriveSessionTitle,
  emptyHistoryStatus,
  messageToText,
  sessionToText,
  HISTORY_PAGE_SIZE,
  type HistoryError,
  type HistoryFact,
  type HistoryMessage,
  type HistoryMessageState,
  type HistoryPage,
  type HistorySession,
  type HistoryStatus,
} from '../shared/history';
import type { ScenarioMode, Speaker, TargetLanguage } from '../shared/types';
import type { SourceMode } from '../shared/sources';

/**
 * 聊天记录的本地数据库（SQLite）。
 *
 * 为什么不用「一个大 JSON」或者 localStorage：
 *  - 每次都重写整个文件，写到一半断电就把**全部**历史毁掉了；
 *  - 消息越多越慢（改成一条要序列化全部）；
 *  - 没有事务，没有索引，搜一条要全表扫。
 *
 * 为什么选 `node-sqlite3-wasm`：
 *  - 它是真正的 SQLite（同样的 SQL、事务、索引），但是 WASM 构建，
 *    **不需要本机编译**。这个项目的路径带中文、目标机器不一定装了 MSVC，
 *    原生模块（better-sqlite3）在这里既难打包也难让朋友装；
 *  - 已在 Electron 33.2.1 主进程实测可用（见 `docs/数据存储与备份.md`）；
 *  - 代价：写入比原生慢，且这个构建下 `journal_mode=WAL` 不生效（实测退回
 *    `delete` 回滚日志）。回滚日志同样是原子的，异常退出不会留下半个事务。
 *
 * 存储位置：`app.getPath('userData')/history.db` —— 用户数据目录，不是安装
 * 目录、不是临时目录，所以卸载重装（不勾选删除数据）与升级都不会清掉它。
 */

export interface HistoryDbOptions {
  dir: string;
  /** 文件名，测试时可以换成别的。 */
  file?: string;
}

/**
 * 库结构版本。
 *
 * 1 → 0.4.0/0.5.0 的首版（sessions / messages / facts）。
 * 2 → 0.6.0：把「理解语言」和「读音提示体系」也存进来。
 *     只加列、不改旧列、不删数据 —— 旧库升上来之后原文照样能读，
 *     只是那几列为空（界面按旧记录处理，不猜）。
 * 3 → 0.6.2：事实卡要连**修改轨迹**一起存：被否定值、改前值、状态、
 *     确认时间、动作日志、「现在该怎么说」。同样只加列。
 */
const SCHEMA_VERSION = 3;

/** 「明确清空」字段 → 真实列名（白名单，列名不从上层的字符串直接拼）。 */
const CLEARABLE_COLUMNS: Record<string, string> = {
  translation: 'translation',
  romanization: 'romanization',
  reply: 'reply',
  correction: 'correction',
  meaning: 'meaning',
  userInput: 'user_input',
};


function nowMs(): number {
  return Date.now();
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : Number(value) || fallback;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export class HistoryStore {
  private db: Database | null = null;
  private filePath = '';
  private lastError = '';
  private integrity = '';
  private openError: HistoryError | null = null;
  /** 每个会话当前的 seq 水位，避免每条消息都查一次 MAX(seq)。 */
  private seqWater: Map<string, number> = new Map();

  constructor(private readonly options: HistoryDbOptions) {}

  // ---- 生命周期 ---------------------------------------------------------

  open(): HistoryStatus {
    try {
      fs.mkdirSync(this.options.dir, { recursive: true });
      this.filePath = path.join(this.options.dir, this.options.file ?? 'history.db');
      this.db = new Database(this.filePath);
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA journal_mode = DELETE');
      this.db.exec('PRAGMA synchronous = FULL');
      this.migrate();
      this.integrity = this.runIntegrityCheck();
      this.openError = null;
      logger.info('History', `opened ${this.filePath} (schema v${this.schemaVersion()})`);
    } catch (error) {
      this.openError = describeHistoryError(error);
      this.lastError = this.openError.title;
      this.db = null;
      logger.error('History', `open failed: ${this.openError.code}`);
      return this.status();
    }
    return this.status();
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      /* 已经关了 */
    }
    this.db = null;
  }

  private schemaVersion(): number {
    const row = this.db?.get('PRAGMA user_version') as { user_version?: number } | null | undefined;
    return toNumber(row?.user_version, 0);
  }

  /**
   * 建表 / 升级。
   *
   * 全部用 `IF NOT EXISTS` + `user_version` 双保险：重复执行不会丢数据、
   * 也不会插重复行（测试里会连续跑两次验证）。
   */
  private migrate() {
    const db = this.requireDb();
    const from = this.schemaVersion();

    if (from < 1) {
      this.tx(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT 'English',
            comprehension TEXT NOT NULL DEFAULT '',
            hint_system TEXT NOT NULL DEFAULT '',
            scenario TEXT NOT NULL DEFAULT 'conversation',
            source_mode TEXT NOT NULL DEFAULT 'online',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            ts INTEGER NOT NULL,
            speaker TEXT NOT NULL DEFAULT 'foreign',
            source TEXT NOT NULL DEFAULT '',
            original TEXT NOT NULL DEFAULT '',
            translation TEXT NOT NULL DEFAULT '',
            romanization TEXT NOT NULL DEFAULT '',
            hint_system TEXT NOT NULL DEFAULT '',
            hint_version INTEGER,
            comprehension TEXT NOT NULL DEFAULT '',
            meaning TEXT NOT NULL DEFAULT '',
            ipa TEXT NOT NULL DEFAULT '',
            syllables TEXT NOT NULL DEFAULT '',
            user_input TEXT NOT NULL DEFAULT '',
            reply TEXT NOT NULL DEFAULT '',
            state TEXT NOT NULL DEFAULT 'final',
            confidence REAL,
            error_code TEXT NOT NULL DEFAULT '',
            error_title TEXT NOT NULL DEFAULT '',
            error_hint TEXT NOT NULL DEFAULT '',
            edited INTEGER NOT NULL DEFAULT 0,
            correction TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
          CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
          CREATE TABLE IF NOT EXISTS facts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT '',
            value TEXT NOT NULL DEFAULT '',
            source_text TEXT NOT NULL DEFAULT '',
            certainty TEXT NOT NULL DEFAULT 'stated',
            confirmed INTEGER NOT NULL DEFAULT 0,
            edited INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            source_field TEXT NOT NULL DEFAULT '',
            negated INTEGER NOT NULL DEFAULT 0,
            original_value TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            confirmed_at INTEGER,
            log TEXT NOT NULL DEFAULT '',
            spoken TEXT NOT NULL DEFAULT '',
            spoken_source TEXT NOT NULL DEFAULT '',
            comprehension TEXT NOT NULL DEFAULT '',
            target_language TEXT NOT NULL DEFAULT '',
            hint_system TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id);
        `);
      });
    }

    if (from < 2) {
      // 只加列。SQLite 的 ADD COLUMN 是老版本就有的能力，不需要重建表，
      // 也就不会碰到「重建表把数据丢了」这类事。
      // 用 table_info 判断，而不是靠 `from` 推断：从 0 新建的库已经带上这些列了。
      this.tx(() => {
        this.addColumnIfMissing('sessions', 'comprehension', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('sessions', 'hint_system', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('messages', 'hint_system', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('messages', 'hint_version', 'INTEGER');
        this.addColumnIfMissing('messages', 'comprehension', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('messages', 'meaning', "TEXT NOT NULL DEFAULT ''");
      });
    }

    if (from < 3) {
      // 事实卡的修改轨迹。老库升上来这些列为空，界面按「未记录」处理，不猜。
      this.tx(() => {
        this.addColumnIfMissing('facts', 'source_field', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('facts', 'negated', 'INTEGER NOT NULL DEFAULT 0');
        this.addColumnIfMissing('facts', 'original_value', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('facts', 'status', "TEXT NOT NULL DEFAULT 'pending'");
        this.addColumnIfMissing('facts', 'confirmed_at', 'INTEGER');
        this.addColumnIfMissing('facts', 'log', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('facts', 'spoken', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('facts', 'spoken_source', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('facts', 'comprehension', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('facts', 'target_language', "TEXT NOT NULL DEFAULT ''");
        this.addColumnIfMissing('facts', 'hint_system', "TEXT NOT NULL DEFAULT ''");
      });
    }

    if (from < SCHEMA_VERSION) {
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      logger.info('History', `schema upgraded v${from} → v${SCHEMA_VERSION}`);
    }
    if (from > SCHEMA_VERSION) {
      logger.warn(
        'History',
        `database schema v${from} is newer than this build (v${SCHEMA_VERSION}); reading only`,
      );
    }
  }

  /** 只在新库里加列；已经有就不动（重复执行安全）。 */
  private addColumnIfMissing(table: string, column: string, definition: string) {
    const rows = this.requireDb().all(`PRAGMA table_info(${table})`) as { name?: string }[];
    if (rows.some((row) => toText(row.name) === column)) return;
    this.requireDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private requireDb(): Database {
    if (!this.db) {
      const error = this.openError ?? describeHistoryError('database not open');
      throw Object.assign(new Error(error.title), { historyError: error });
    }
    return this.db;
  }

  /** 一个事务包住一批写；出错整体回滚，绝不留半个事务。 */
  private tx<T>(fn: () => T): T {
    const db = this.requireDb();
    if (db.inTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也要把原始错误抛出去 */
      }
      throw error;
    }
  }

  private runIntegrityCheck(): string {
    try {
      const row = this.requireDb().get('PRAGMA quick_check') as { quick_check?: string } | null;
      return toText(row?.quick_check) || 'unknown';
    } catch {
      return 'unavailable';
    }
  }

  // ---- 状态 -------------------------------------------------------------

  status(): HistoryStatus {
    if (!this.db) {
      return {
        ...emptyHistoryStatus(),
        file: this.filePath,
        lastError: this.lastError,
        integrity: this.integrity,
      };
    }
    try {
      const sessions = this.db.get('SELECT COUNT(*) AS c FROM sessions') as { c?: number } | null;
      const messages = this.db.get('SELECT COUNT(*) AS c FROM messages') as { c?: number } | null;
      const bytes = (() => {
        try {
          return fs.statSync(this.filePath).size;
        } catch {
          return 0;
        }
      })();
      return {
        ready: true,
        file: this.filePath,
        bytes,
        sessions: toNumber(sessions?.c),
        messages: toNumber(messages?.c),
        lastError: this.lastError,
        integrity: this.integrity,
      };
    } catch (error) {
      this.lastError = describeHistoryError(error).title;
      return {
        ...emptyHistoryStatus(),
        file: this.filePath,
        lastError: this.lastError,
      };
    }
  }

  // ---- 会话 -------------------------------------------------------------

  createSession(input: {
    id: string;
    language: TargetLanguage;
    scenario: ScenarioMode;
    sourceMode: SourceMode;
    /** 记录这段对话时使用者理解的语言（译文用哪种）。 */
    comprehension?: string;
    /** 这段对话里的读音提示体系。 */
    hintSystem?: string;
    title?: string;
    createdAt?: number;
  }): HistorySession {
    const db = this.requireDb();
    const at = input.createdAt ?? nowMs();
    this.tx(() => {
      db.run(
        `INSERT INTO sessions (id, title, language, comprehension, hint_system, scenario, source_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [
          input.id,
          input.title ?? '',
          input.language,
          input.comprehension ?? '',
          input.hintSystem ?? '',
          input.scenario,
          input.sourceMode,
          at,
          at,
        ],
      );
    });
    return this.getSession(input.id) as HistorySession;
  }

  /**
   * 会话不存在就建（渲染层不用先问「有没有」）。
   *
   * 存在时**补空字段**：用户可能先说了两句才去设置里换理解语言，
   * 这之前那一行是空的；补上比留空更好，但绝不覆盖已经记下来的值。
   */
  ensureSession(input: {
    id: string;
    language: TargetLanguage;
    scenario: ScenarioMode;
    sourceMode: SourceMode;
    comprehension?: string;
    hintSystem?: string;
  }): HistorySession {
    const existing = this.getSession(input.id);
    if (existing) {
      const patch: string[] = [];
      const args: (string | number)[] = [];
      if (!existing.comprehension && input.comprehension) {
        patch.push('comprehension = ?');
        args.push(input.comprehension);
      }
      if (!existing.hintSystem && input.hintSystem) {
        patch.push('hint_system = ?');
        args.push(input.hintSystem);
      }
      if (patch.length) {
        this.tx(() => {
          this.requireDb().run(`UPDATE sessions SET ${patch.join(', ')} WHERE id = ?`, [
            ...args,
            input.id,
          ]);
        });
        return this.getSession(input.id) as HistorySession;
      }
      return existing;
    }
    return this.createSession(input);
  }

  getSession(id: string): HistorySession | null {
    const row = this.requireDb().get(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s WHERE s.id = ?`,
      [id],
    );
    return row ? this.mapSession(row) : null;
  }

  renameSession(id: string, title: string) {
    this.tx(() => {
      this.requireDb().run('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', [
        title.slice(0, 120),
        nowMs(),
        id,
      ]);
    });
  }

  deleteSession(id: string) {
    this.tx(() => {
      this.requireDb().run('DELETE FROM sessions WHERE id = ?', [id]);
    });
    this.seqWater.delete(id);
  }

  /** 只有用户明确点「清空全部历史」才会走到这里。 */
  clearAll(): { sessions: number; messages: number } {
    const db = this.requireDb();
    const before = this.status();
    this.tx(() => {
      db.run('DELETE FROM messages');
      db.run('DELETE FROM facts');
      db.run('DELETE FROM sessions');
    });
    this.seqWater.clear();
    return { sessions: before.sessions, messages: before.messages };
  }

  /**
   * 会话列表（分页）。
   *
   * 永远不返回全部 —— 一万条消息的用户滚动列表时，界面只需要这一页。
   */
  listSessions(options: { limit?: number; offset?: number } = {}): {
    items: HistorySession[];
    total: number;
  } {
    const db = this.requireDb();
    const limit = Math.max(1, Math.min(200, options.limit ?? 30));
    const offset = Math.max(0, options.offset ?? 0);
    const total = toNumber(
      (db.get('SELECT COUNT(*) AS c FROM sessions') as { c?: number } | null)?.c,
    );
    const rows = db.all(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM sessions s
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return { items: rows.map((row) => this.mapSession(row)), total };
  }

  // ---- 消息 -------------------------------------------------------------

  /**
   * 批量写入 / 更新消息。
   *
   * 同一个 id 反复更新会覆盖同一行 —— 转写先到、译文后到，不会变成两条记录。
   * 新消息的 seq 由主进程分配（会话内单调递增），保证顺序稳定。
   */
  upsertMessages(
    sessionId: string,
    messages: HistoryMessage[],
  ): { written: number; session: HistorySession | null } {
    if (!messages.length) return { written: 0, session: this.getSession(sessionId) };
    const db = this.requireDb();

    this.tx(() => {
      let water = this.seqWater.get(sessionId);
      if (water === undefined) {
        const row = db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ?', [
          sessionId,
        ]) as { m?: number } | null;
        water = toNumber(row?.m);
      }
      for (const message of messages) {
        const existing = db.get('SELECT seq FROM messages WHERE id = ?', [message.id]) as
          | { seq?: number }
          | null;
        let seq = message.seq;
        if (existing) {
          seq = toNumber(existing.seq, message.seq);
        } else {
          water += 1;
          seq = water;
        }
        db.run(
          `INSERT INTO messages (
             id, session_id, seq, ts, speaker, source, original, translation, romanization,
             hint_system, hint_version, comprehension, meaning,
             ipa, syllables, user_input, reply, state, confidence,
             error_code, error_title, error_hint, edited, correction
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             ts = excluded.ts,
             speaker = excluded.speaker,
             source = excluded.source,
             original = excluded.original,
             translation = excluded.translation,
             romanization = excluded.romanization,
             hint_system = CASE WHEN excluded.hint_system = '' THEN messages.hint_system ELSE excluded.hint_system END,
             hint_version = COALESCE(excluded.hint_version, messages.hint_version),
             comprehension = CASE WHEN excluded.comprehension = '' THEN messages.comprehension ELSE excluded.comprehension END,
             meaning = CASE WHEN excluded.meaning = '' THEN messages.meaning ELSE excluded.meaning END,
             ipa = excluded.ipa,
             syllables = excluded.syllables,
             user_input = CASE WHEN excluded.user_input = '' THEN messages.user_input ELSE excluded.user_input END,
             reply = CASE WHEN excluded.reply = '' THEN messages.reply ELSE excluded.reply END,
             state = excluded.state,
             confidence = excluded.confidence,
             error_code = excluded.error_code,
             error_title = excluded.error_title,
             error_hint = excluded.error_hint,
             edited = MAX(messages.edited, excluded.edited),
             correction = CASE WHEN excluded.correction = '' THEN messages.correction ELSE excluded.correction END`,
          [
            message.id,
            sessionId,
            seq,
            message.ts,
            message.speaker,
            message.source ?? '',
            message.original,
            message.translation,
            message.romanization,
            message.hintSystem ?? '',
            message.hintVersion ?? null,
            message.comprehension ?? '',
            message.meaning ?? '',
            message.ipa ?? '',
            JSON.stringify(message.syllables ?? []),
            message.userInput ?? '',
            message.reply ?? '',
            message.state,
            message.confidence ?? null,
            message.translationError?.code ?? '',
            message.translationError?.title ?? '',
            message.translationError?.hint ?? '',
            message.edited ? 1 : 0,
            message.correction ?? '',
          ],
        );
      }
      /*
       * 「明确清空」放在 upsert 之后执行。
       *
       * 顺序反了就没意义：ON CONFLICT 里空值不覆盖，正是为了挡住迟到更新
       * 把已存内容冲掉；用户真的要删某个字段时，只能在这一行落库之后再补
       * 一条 UPDATE。列名走白名单，不让上层把列名拼进 SQL。
       */
      for (const message of messages) {
        const columns = Array.from(
          new Set(
            (message.cleared ?? [])
              .map((field) => CLEARABLE_COLUMNS[field])
              .filter((column): column is string => Boolean(column)),
          ),
        );
        if (!columns.length) continue;
        const sets = columns.map((column) => `${column} = ''`).join(', ');
        db.run(`UPDATE messages SET ${sets} WHERE id = ? AND session_id = ?`, [
          message.id,
          sessionId,
        ]);
      }
      this.seqWater.set(sessionId, water);
      this.touchSession(sessionId, messages);
    });

    return { written: messages.length, session: this.getSession(sessionId) };
  }

  private touchSession(sessionId: string, messages: HistoryMessage[]) {
    const db = this.requireDb();
    const session = db.get('SELECT title FROM sessions WHERE id = ?', [sessionId]) as
      | { title?: string }
      | null;
    const firstForeign = messages.find(
      (m) => m.speaker === 'foreign' && m.original.trim().length > 0,
    );
    const nextTitle =
      session && toText(session.title).trim()
        ? toText(session.title)
        : firstForeign
          ? deriveSessionTitle([firstForeign.original], firstForeign.ts)
          : '';
    db.run('UPDATE sessions SET updated_at = ?, title = ? WHERE id = ?', [
      nowMs(),
      nextTitle,
      sessionId,
    ]);
  }

  /** 分页读一个会话：从新往旧取，`beforeSeq` 是向上加载的游标。 */
  getPage(
    sessionId: string,
    options: { beforeSeq?: number | null; limit?: number } = {},
  ): HistoryPage {
    const db = this.requireDb();
    const limit = Math.max(1, Math.min(200, options.limit ?? HISTORY_PAGE_SIZE));
    const beforeSeq = options.beforeSeq ?? null;
    const rows = beforeSeq
      ? db.all(
          'SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
          [sessionId, beforeSeq, limit + 1],
        )
      : db.all('SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?', [
          sessionId,
          limit + 1,
        ]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => this.mapMessage(row));
    page.reverse();
    return {
      sessionId,
      messages: page,
      hasMore,
      nextBeforeSeq: hasMore && page.length ? page[0].seq : null,
    };
  }

  /** 取整个会话（导出 / 备份用，测试里也用它核对条数）。 */
  getAllMessages(sessionId: string): HistoryMessage[] {
    const rows = this.requireDb().all(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC',
      [sessionId],
    );
    return rows.map((row) => this.mapMessage(row));
  }

  countMessages(sessionId: string): number {
    const row = this.requireDb().get('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?', [
      sessionId,
    ]) as { c?: number } | null;
    return toNumber(row?.c);
  }

  // ---- 事实卡 -----------------------------------------------------------

  /**
   * 事实卡落盘。
   *
   * `removedIds` 是「用户真的删掉了这几条」—— 只 upsert 不删的话，删掉的事实
   * 下次打开记录又回来了（和字幕的「明确清空」是同一个坑）。
   */
  saveFacts(sessionId: string, facts: HistoryFact[], removedIds: string[] = []) {
    const removed = removedIds.filter((id) => typeof id === 'string' && id);
    if (!facts.length && !removed.length) return;
    const db = this.requireDb();
    this.tx(() => {
      for (const id of removed) {
        db.run('DELETE FROM facts WHERE id = ? AND session_id = ?', [id, sessionId]);
      }
      for (const fact of facts) {
        db.run(
          `INSERT INTO facts (
             id, session_id, message_id, kind, value, source_text, certainty,
             confirmed, edited, created_at, source_field, negated, original_value,
             status, confirmed_at, log, spoken, spoken_source, comprehension,
             target_language, hint_system
           )
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             value = excluded.value,
             source_text = excluded.source_text,
             certainty = excluded.certainty,
             confirmed = excluded.confirmed,
             edited = excluded.edited,
             source_field = excluded.source_field,
             negated = excluded.negated,
             original_value = excluded.original_value,
             status = excluded.status,
             confirmed_at = excluded.confirmed_at,
             log = excluded.log,
             spoken = excluded.spoken,
             spoken_source = excluded.spoken_source,
             comprehension = excluded.comprehension,
             target_language = excluded.target_language,
             hint_system = excluded.hint_system`,
          [
            fact.id,
            sessionId,
            fact.messageId,
            fact.kind,
            fact.value,
            fact.sourceText,
            fact.certainty,
            fact.confirmed ? 1 : 0,
            fact.edited ? 1 : 0,
            fact.createdAt,
            fact.sourceField ?? '',
            fact.negated ? 1 : 0,
            fact.originalValue ?? '',
            fact.status ?? (fact.confirmed ? 'confirmed' : 'pending'),
            fact.confirmedAt ?? null,
            fact.log?.length ? JSON.stringify(fact.log) : '',
            fact.spoken ?? '',
            fact.spokenSource ?? '',
            fact.comprehension ?? '',
            fact.targetLanguage ?? '',
            fact.hintSystem ?? '',
          ],
        );
      }
    });
  }

  getFacts(sessionId: string): HistoryFact[] {
    const rows = this.requireDb().all(
      'SELECT * FROM facts WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    );
    return rows.map((row) => {
      let log: HistoryFact['log'];
      const rawLog = toText(row.log);
      if (rawLog) {
        try {
          const parsed = JSON.parse(rawLog);
          if (Array.isArray(parsed)) log = parsed as HistoryFact['log'];
        } catch {
          // 解析不了就当没记录 —— 不猜、不重建。
        }
      }
      const confirmed = toNumber(row.confirmed) === 1;
      const status = toText(row.status);
      return {
        id: toText(row.id),
        sessionId: toText(row.session_id),
        messageId: toText(row.message_id),
        kind: toText(row.kind),
        value: toText(row.value),
        sourceText: toText(row.source_text),
        certainty: toText(row.certainty) || 'stated',
        confirmed: status === 'confirmed' || (status === '' && confirmed),
        edited: toNumber(row.edited) === 1,
        createdAt: toNumber(row.created_at),
        sourceField: toText(row.source_field) || undefined,
        negated: toNumber(row.negated) === 1 || undefined,
        originalValue: toText(row.original_value) || undefined,
        status: status === 'confirmed' ? 'confirmed' : 'pending',
        confirmedAt: toNumber(row.confirmed_at) || undefined,
        log,
        spoken: toText(row.spoken) || undefined,
        spokenSource: (toText(row.spoken_source) as HistoryFact['spokenSource']) || undefined,
        comprehension: toText(row.comprehension) || undefined,
        targetLanguage: toText(row.target_language) || undefined,
        hintSystem: toText(row.hint_system) || undefined,
      };
    });
  }

  // ---- 搜索 -------------------------------------------------------------

  /**
   * 搜索会话（标题）与消息正文（原文 / 译文 / 谐音）。
   *
   * 用 LIKE 而不是 FTS5：这个 WASM 构建没有编进 FTS5，而万级数据量下
   * LIKE 全表扫在本地文件上仍是毫秒级（测试里有 1 万条的实际数字）。
   * 好处是不会因为「分词器不认识中文」而搜不到。
   */
  search(
    query: string,
    options: { limit?: number } = {},
  ): { items: (HistorySession & { snippet: string; hits: number })[]; total: number } {
    const db = this.requireDb();
    const text = query.trim();
    if (!text) return { items: [], total: 0 };
    const limit = Math.max(1, Math.min(100, options.limit ?? 30));
    const like = `%${text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = db.all(
      `SELECT s.*,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
              (SELECT COUNT(*) FROM messages m
                 WHERE m.session_id = s.id
                   AND (m.original LIKE ? ESCAPE '\\'
                     OR m.translation LIKE ? ESCAPE '\\'
                     OR m.romanization LIKE ? ESCAPE '\\')) AS hits,
              (SELECT m.translation || ' ' || m.original FROM messages m
                 WHERE m.session_id = s.id
                   AND (m.original LIKE ? ESCAPE '\\'
                     OR m.translation LIKE ? ESCAPE '\\'
                     OR m.romanization LIKE ? ESCAPE '\\')
                 ORDER BY m.seq ASC LIMIT 1) AS snippet
       FROM sessions s
       WHERE s.title LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM messages m2 WHERE m2.session_id = s.id
           AND (m2.original LIKE ? ESCAPE '\\'
             OR m2.translation LIKE ? ESCAPE '\\'
             OR m2.romanization LIKE ? ESCAPE '\\')
       )
       ORDER BY s.updated_at DESC
       LIMIT ?`,
      [like, like, like, like, like, like, like, like, like, like, limit],
    );
    const items = rows.map((row) => ({
      ...this.mapSession(row),
      hits: toNumber(row.hits),
      snippet: toText(row.snippet).replace(/\s+/g, ' ').slice(0, 80),
    }));
    return { items, total: items.length };
  }

  // ---- 导出 / 备份 ------------------------------------------------------

  /**
   * 分批把一个会话写成文本。
   *
   * 一万一万条一次性拼成字符串会卡住主进程（也就卡住界面），所以按 500 条
   * 一批 append 到文件。`onProgress` 让上层可以显示进度。
   */
  exportSessionText(sessionId: string, file: string, batch = 500): { messages: number } {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('找不到这个会话');
    const total = this.countMessages(sessionId);
    fs.writeFileSync(file, '', 'utf8');
    // 头一次写入标题信息（消息为空也要有头部）。
    const head = sessionToText({ ...session, messageCount: total }, [], this.getFacts(sessionId));
    fs.writeFileSync(file, head, 'utf8');

    const db = this.requireDb();
    let written = 0;
    let cursor = 0;
    while (written < total) {
      const rows = db.all(
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
        [sessionId, cursor, batch],
      );
      if (!rows.length) break;
      const messages = rows.map((row) => this.mapMessage(row));
      cursor = messages[messages.length - 1].seq;
      written += messages.length;
      const chunk = messages.map(messageToBlock).join('\n\n');
      fs.appendFileSync(file, `${chunk}\n\n`, 'utf8');
    }
    return { messages: written };
  }

  /** 结构化备份：一个 JSON 文件，含全部会话 / 消息 / 事实。 */
  exportJson(file: string, batch = 500): { sessions: number; messages: number } {
    const db = this.requireDb();
    const sessions = db.all('SELECT * FROM sessions ORDER BY created_at ASC');
    const out: Record<string, unknown>[] = [];
    let messageCount = 0;
    for (const row of sessions) {
      const session = this.mapSession(row);
      const messages: HistoryMessage[] = [];
      let cursor = 0;
      for (;;) {
        const rows = db.all(
          'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
          [session.id, cursor, batch],
        );
        if (!rows.length) break;
        const page = rows.map((r) => this.mapMessage(r));
        cursor = page[page.length - 1].seq;
        messages.push(...page);
      }
      messageCount += messages.length;
      out.push({ session, messages, facts: this.getFacts(session.id) });
    }
    fs.writeFileSync(
      file,
      JSON.stringify(
        { format: 'ai-conversation-copilot/history', version: 2, exportedAt: nowMs(), sessions: out },
        null,
        2,
      ),
      'utf8',
    );
    return { sessions: sessions.length, messages: messageCount };
  }

  /**
   * 一致备份：用 `VACUUM INTO`。
   *
   * 直接 `copyFile` 一个还在写入的数据库是**不安全**的 —— 可能拷到半个事务。
   * `VACUUM INTO` 由 SQLite 自己生成一份一致快照，不需要停应用。
   */
  backupTo(file: string): { bytes: number } {
    const db = this.requireDb();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return { bytes: fs.statSync(file).size };
  }

  // ---- 行映射 -----------------------------------------------------------

  private mapSession(row: Record<string, unknown>): HistorySession {
    return {
      id: toText(row.id),
      title: toText(row.title),
      language: (toText(row.language) || 'English') as TargetLanguage,
      comprehension: toText(row.comprehension) || undefined,
      hintSystem: toText(row.hint_system) || undefined,
      scenario: (toText(row.scenario) || 'conversation') as ScenarioMode,
      sourceMode: (toText(row.source_mode) || 'online') as SourceMode,
      createdAt: toNumber(row.created_at),
      updatedAt: toNumber(row.updated_at),
      messageCount: toNumber(row.message_count),
    };
  }

  private mapMessage(row: Record<string, unknown>): HistoryMessage {
    let syllables: string[] = [];
    try {
      const parsed = JSON.parse(toText(row.syllables) || '[]');
      if (Array.isArray(parsed)) syllables = parsed.filter((s) => typeof s === 'string');
    } catch {
      syllables = [];
    }
    const errorCode = toText(row.error_code);
    return {
      id: toText(row.id),
      sessionId: toText(row.session_id),
      seq: toNumber(row.seq),
      ts: toNumber(row.ts),
      speaker: (toText(row.speaker) || 'foreign') as Speaker,
      source: (toText(row.source) || '') as 'system' | 'mic' | '',
      original: toText(row.original),
      translation: toText(row.translation),
      romanization: toText(row.romanization),
      hintSystem: toText(row.hint_system) || undefined,
      hintVersion:
        row.hint_version == null || toText(row.hint_version) === ''
          ? undefined
          : toNumber(row.hint_version),
      comprehension: toText(row.comprehension) || undefined,
      meaning: toText(row.meaning) || undefined,
      ipa: toText(row.ipa) || undefined,
      syllables: syllables.length ? syllables : undefined,
      userInput: toText(row.user_input) || undefined,
      reply: toText(row.reply) || undefined,
      state: (toText(row.state) || 'final') as HistoryMessageState,
      confidence: row.confidence == null ? undefined : toNumber(row.confidence),
      translationError: errorCode
        ? {
            code: errorCode,
            title: toText(row.error_title),
            hint: toText(row.error_hint),
          }
        : undefined,
      edited: toNumber(row.edited) === 1,
      correction: toText(row.correction) || undefined,
    };
  }
}

/** 导出里的单条消息块（不带头部）。 */
function messageToBlock(message: HistoryMessage): string {
  return messageToText(message);
}

let store: HistoryStore | null = null;

/** 主进程启动时调一次。失败不阻塞应用启动，界面会显示「记录不可用」。 */
export function initHistoryStore(dir: string): HistoryStatus {
  if (store) return store.status();
  store = new HistoryStore({ dir });
  return store.open();
}

export function getHistoryStore(): HistoryStore {
  if (!store) throw new Error('history store not initialised');
  return store;
}

export function hasHistoryStore(): boolean {
  return store !== null;
}

/** 退出时关库。已经 COMMIT 的数据都在文件里，这一步只收句柄。 */
export function closeHistoryStore() {
  if (!store) return;
  try {
    store.close();
  } catch {
    /* 已经关了 */
  }
  store = null;
}
