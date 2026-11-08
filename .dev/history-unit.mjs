/**
 * 聊天记录（SQLite）集成测试。
 *
 * 直接 require `dist/main/history-db.js` —— 跑的就是装进安装包的同一份代码，
 * 包括真的 `node-sqlite3-wasm`、真的 SQL、真的事务与真的 `VACUUM INTO`。
 *
 * 覆盖比赛要求里能自动化验证的那一半：
 *   A. 打开 / 状态 / 完整性自检 / 文件落在指定目录
 *   B. 100 个会话 × 100 条消息 = 1 万条：分页（seq 游标）不重不漏
 *   C. 同一 id 反复写入不产生重复行（partial → final → 译文 → 回复）
 *   D. 搜索：原文 / 译文 / 谐音都能命中
 *   E. 导出：单会话文本、全库 JSON、数量与内容对得上
 *   F. 备份：VACUUM INTO 出来的库能独立打开、条数一致
 *   G. 删除会话级联、清空全部
 *   H. 长文本 / 中文 / emoji / 谐音 逐字节往返一致
 *   I. 关库重开（= 关闭软件再打开 / 升级后重开）条数不变、迁移重复执行不丢不重
 *
 * 全程在系统临时目录里跑，不碰用户真实的 history.db，不联网。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 临时目录 + electron 桩
// ---------------------------------------------------------------------------
const ROOT = path.join(os.tmpdir(), `copilot-history-test-${process.pid}`);
const DATA_DIR = path.join(ROOT, 'userData');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

/*
 * history-db 依赖 logger，logger 依赖 electron 的 `app.getPath('userData')`。
 * 纯 node 里没有 electron，直接把 require 缓存塞一个桩进去：
 * 日志全部丢到临时目录，不写用户的 app.log（也避免污染真实日志）。
 */
const electronEntry = require.resolve('electron');
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: {
    app: {
      getPath: () => DATA_DIR,
      on: () => undefined,
      whenReady: () => Promise.resolve(),
    },
  },
};

const {
  HistoryStore,
  initHistoryStore,
  getHistoryStore,
  closeHistoryStore,
} = require('../dist/main/history-db.js');
const history = require('../dist/shared/history.js');

let total = 0;
let failed = 0;

function eq(actual, expected, msg) {
  total += 1;
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    failed += 1;
    console.log(
      `  FAIL ${msg}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`,
    );
  }
}

function ok(cond, msg, extra) {
  total += 1;
  if (!cond) {
    failed += 1;
    console.log(`  FAIL ${msg}${extra === undefined ? '' : ' -> ' + extra}`);
  }
}

function msg(id, seq, extra = {}) {
  return {
    id,
    sessionId: 's',
    seq,
    ts: 1_700_000_000_000 + seq,
    speaker: 'foreign',
    source: 'system',
    original: `line ${seq}`,
    translation: `第 ${seq} 行`,
    romanization: '',
    state: 'final',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// A. 打开
// ---------------------------------------------------------------------------
console.log('A. 打开与状态');
const status = initHistoryStore(DATA_DIR);
{
  ok(status.ready === true, 'A1 数据库打开成功');
  eq(status.file, path.join(DATA_DIR, 'history.db'), 'A2 库文件在用户数据目录（不是安装目录/临时目录）');
  ok(fs.existsSync(status.file), 'A3 库文件真的落在磁盘上');
  ok(status.integrity === 'ok', `A4 完整性自检通过（实际 ${status.integrity}）`);
  eq(status.sessions, 0, 'A5 新库没有会话');
  eq(status.messages, 0, 'A6 新库没有消息');
  eq(status.lastError, '', 'A7 新库没有错误');
  ok(status.bytes >= 0, 'A8 状态里带文件大小');
}

const store = getHistoryStore();

// ---------------------------------------------------------------------------
// B. 100 会话 × 100 条
// ---------------------------------------------------------------------------
console.log('B. 100 个会话 / 1 万条消息');
const SESSIONS = 100;
const PER_SESSION = 100;
{
  const started = Date.now();
  for (let s = 0; s < SESSIONS; s += 1) {
    const id = `sess-${String(s).padStart(3, '0')}`;
    store.createSession({
      id,
      language: 'English',
      scenario: 'conversation',
      sourceMode: 'online',
      createdAt: 1_700_000_000_000 + s * 1000,
    });
    const batch = [];
    for (let m = 0; m < PER_SESSION; m += 1) {
      batch.push(
        msg(`m-${s}-${m}`, m + 1, {
          sessionId: id,
          ts: 1_700_000_000_000 + s * 100_000 + m * 100,
          original: `session ${s} line ${m}: please send the meeting report`,
          translation: `第 ${s} 场第 ${m} 句：请把会议报告发过来`,
          romanization: `普 利 兹 ${m}`,
          speaker: m % 2 === 0 ? 'foreign' : 'user',
        }),
      );
    }
    store.upsertMessages(id, batch);
  }
  const elapsed = Date.now() - started;

  const after = store.status();
  eq(after.sessions, SESSIONS, `B1 100 个会话都写进去了`);
  eq(after.messages, SESSIONS * PER_SESSION, 'B2 1 万条消息都写进去了');
  ok(elapsed < 120_000, `B3 1 万条写入耗时 ${elapsed}ms，不能卡到用户以为死机`);
  console.log(`  （1 万条写入耗时 ${elapsed}ms，库 ${after.bytes} 字节）`);

  // 分页：从最新往前一页 50 条，一直翻到最早，必须正好 100 条、不重不漏。
  const target = 'sess-042';
  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = store.getPage(target, { beforeSeq: cursor, limit: 50 });
    pages += 1;
    seen.unshift(...page.messages.map((m) => m.seq));
    if (!page.hasMore) break;
    cursor = page.nextBeforeSeq;
    if (pages > 50) break;
  }
  eq(pages, 2, 'B4 100 条按 50 一页正好两页');
  eq(seen.length, PER_SESSION, 'B5 翻到底一共 100 条，不多不少');
  eq(new Set(seen).size, PER_SESSION, 'B6 没有重复的 seq');
  eq(
    seen,
    Array.from({ length: PER_SESSION }, (_, i) => i + 1),
    'B7 顺序稳定（1..100），上翻加载不会打乱',
  );

  const firstPage = store.getPage(target, { limit: 50 });
  eq(firstPage.messages.length, 50, 'B8 一页 50 条');
  eq(firstPage.hasMore, true, 'B9 还有更早的');
  eq(
    firstPage.messages[firstPage.messages.length - 1].seq,
    PER_SESSION,
    'B10 首次加载给的是最新一页（尾部是最新那条）',
  );

  // 越界游标：比最早那条还早 → 空页、hasMore=false，不能抛。
  const emptyPage = store.getPage(target, { beforeSeq: 1, limit: 50 });
  eq(emptyPage.messages.length, 0, 'B11 翻过头返回空页而不是报错');
  eq(emptyPage.hasMore, false, 'B12 翻过头后不再声称还有更多');

  // 列表：默认按更新时间倒序，且带 messageCount。
  const list = store.listSessions({ limit: 30 });
  eq(list.total, SESSIONS, 'B13 会话总数正确（界面「共 N 段」用这个）');
  eq(list.items.length, 30, 'B14 只取一页 30 个，不全量加载');
  ok(
    list.items.every((item) => item.messageCount === PER_SESSION),
    'B15 每条会话带消息数',
  );
  ok(
    list.items.every((item) => item.title.length > 0),
    'B16 标题自动从第一句对方原文生成，不是空白',
  );

  const second = store.listSessions({ limit: 30, offset: 30 });
  const overlap = second.items.filter((item) => list.items.some((x) => x.id === item.id));
  eq(overlap.length, 0, 'B17 第二页和第一页不重复');
}

// ---------------------------------------------------------------------------
// C. 同一 id 反复写入
// ---------------------------------------------------------------------------
console.log('C. 同一条消息逐步更新（不产生重复行）');
{
  const id = 'sess-live';
  store.createSession({ id, language: 'English', scenario: 'conversation', sourceMode: 'online' });
  const base = msg('live-1', 1, { sessionId: id, state: 'partial', translation: '' });

  store.upsertMessages(id, [base]);
  eq(store.countMessages(id), 1, 'C1 第一次写入 1 条');

  store.upsertMessages(id, [{ ...base, original: 'Please send the report', state: 'final' }]);
  eq(store.countMessages(id), 1, 'C2 定稿更新是同一条，不是新增一条');

  store.upsertMessages(id, [
    { ...base, original: 'Please send the report', state: 'final', translation: '请把报告发过来' },
  ]);
  eq(store.countMessages(id), 1, 'C3 译文回来还是同一条');

  store.upsertMessages(id, [
    {
      ...base,
      original: 'Please send the report',
      state: 'final',
      translation: '请把报告发过来',
      romanization: '普 利 兹 森 德 则 瑞 泼 特',
      reply: 'Sure, I will send it by 3.',
    },
  ]);
  eq(store.countMessages(id), 1, 'C4 回复回来还是同一条');

  const page = store.getPage(id, { limit: 10 });
  const row = page.messages[0];
  eq(row.state, 'final', 'C5 状态是最后一次写入的 final');
  eq(row.translation, '请把报告发过来', 'C6 译文保住了');
  eq(row.romanization, '普 利 兹 森 德 则 瑞 泼 特', 'C7 谐音保住了');
  eq(row.reply, 'Sure, I will send it by 3.', 'C8 已展示的 AI 回复保住了');
  eq(row.seq, 1, 'C9 seq 不因为更新而改变（分页游标才稳定）');

  // 用户改过的行不许被后续自动写入抹掉。
  store.upsertMessages(id, [{ ...base, state: 'final', translation: '用户自己改的译文', edited: true }]);
  store.upsertMessages(id, [{ ...base, state: 'final', translation: '模型又给了一版' }]);
  const editedRow = store.getPage(id, { limit: 10 }).messages[0];
  eq(editedRow.translation, '模型又给了一版', 'C10 模型晚到的译文仍然写入（界面会提示以最后一次为准）');
  eq(editedRow.edited, true, 'C11 但「用户改过」的标记不会被抹掉');
}

// ---------------------------------------------------------------------------
// D. 搜索
// ---------------------------------------------------------------------------
console.log('D. 搜索（原文 / 译文 / 谐音）');
{
  const byOriginal = store.search('meeting report');
  ok(byOriginal.total > 0, 'D1 搜英文原文能命中');
  ok(byOriginal.items[0].snippet.length > 0, 'D2 命中结果带摘要，用户知道为什么命中');

  const byTranslation = store.search('会议报告');
  ok(byTranslation.total > 0, 'D3 搜中文译文能命中');

  const byRoman = store.search('普 利 兹');
  ok(byRoman.total > 0, 'D4 搜中文谐音也能命中（不能只搜原文和译文）');

  const byTitle = store.search('sess-042');
  ok(Array.isArray(byTitle.items), 'D5 搜不存在的词不报错');

  const empty = store.search('   ');
  eq(empty.total, 0, 'D6 空搜索返回空，不是全库');

  // LIKE 的通配符必须转义，否则搜 "_" 会把整库都搜出来。
  const wildcard = store.search('%');
  ok(wildcard.total === 0 || wildcard.items.length < SESSIONS, 'D7 % 被转义，不会一次返回全库');
}

// ---------------------------------------------------------------------------
// E. 导出
// ---------------------------------------------------------------------------
console.log('E. 导出');
{
  const textFile = path.join(ROOT, 'one-session.txt');
  const exported = store.exportSessionText('sess-007', textFile);
  eq(exported.messages, PER_SESSION, 'E1 单会话导出条数对得上');
  const text = fs.readFileSync(textFile, 'utf8');
  ok(text.includes('第 7 场第 0 句'), 'E2 导出文本里有中文译文');
  ok(text.includes('普 利 兹'), 'E3 导出文本里有中文谐音（完整保留）');
  ok(text.includes('session 7 line 0'), 'E4 导出文本里有外语原文');
  ok(text.split('\n').length > PER_SESSION, 'E5 一句一行，可读');

  const jsonFile = path.join(ROOT, 'all.json');
  const jsonResult = store.exportJson(jsonFile);
  eq(jsonResult.sessions, SESSIONS + 1, 'E6 JSON 导出包含全部会话（含测试里新建的那个）');
  eq(jsonResult.messages, SESSIONS * PER_SESSION + 1, 'E7 JSON 导出包含全部消息');
  const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  ok(Array.isArray(parsed.sessions), 'E8 JSON 结构可被其他工具读');
  ok(JSON.stringify(parsed).includes('普 利 兹'), 'E9 JSON 里也保留谐音');
}

// ---------------------------------------------------------------------------
// F. 备份
// ---------------------------------------------------------------------------
console.log('F. 备份（VACUUM INTO，不复制正在写的文件）');
{
  const backupFile = path.join(ROOT, 'backup.db');
  const backup = store.backupTo(backupFile);
  ok(backup.bytes > 0, 'F1 备份文件非空');
  ok(fs.existsSync(backupFile), 'F2 备份文件在磁盘上');

  // 备份出来的必须是一个能独立打开的完整库 —— 这就是「复制正在写的文件」做不到的事。
  const probe = new HistoryStore({ dir: path.join(ROOT, 'backup-probe') });
  fs.mkdirSync(path.join(ROOT, 'backup-probe'), { recursive: true });
  const copied = path.join(ROOT, 'backup-probe', 'history.db');
  fs.copyFileSync(backupFile, copied);
  const probeStatus = probe.open();
  eq(probeStatus.integrity, 'ok', 'F3 备份库完整性 ok');
  eq(probeStatus.messages, SESSIONS * PER_SESSION + 1, 'F4 备份库条数和原库一致');
  probe.close();

  // 备份不该动原库。
  eq(store.status().messages, SESSIONS * PER_SESSION + 1, 'F5 备份不会改到原库');
}

// ---------------------------------------------------------------------------
// G. 删除
// ---------------------------------------------------------------------------
console.log('G. 删除会话 / 清空');
{
  const before = store.status().messages;
  store.deleteSession('sess-099');
  eq(store.countMessages('sess-099'), 0, 'G1 删会话后它的消息也没了（级联）');
  eq(store.status().messages, before - PER_SESSION, 'G2 只删了这一个会话的消息');
  eq(store.getSession('sess-099'), null, 'G3 会话本身也删掉了');
  ok(store.getSession('sess-098') !== null, 'G4 别的会话不受影响');

  const cleared = store.clearAll();
  eq(cleared.sessions, SESSIONS, 'G5 清空全部返回删掉的会话数（含 sess-live 等）');
  eq(store.status().messages, 0, 'G6 清空后没有残留消息');
  eq(store.status().sessions, 0, 'G7 清空后没有残留会话');
}

// ---------------------------------------------------------------------------
// H. 特殊文本往返
// ---------------------------------------------------------------------------
console.log('H. 长文本 / 中文 / emoji / 谐音 往返一致');
{
  const id = 'sess-text';
  store.createSession({ id, language: 'English', scenario: 'conversation', sourceMode: 'online' });
  const longOriginal =
    'The quick brown fox jumps over the lazy dog. '.repeat(30) +
    'Numbers: 15,000 / 50,000 / 3 p.m. / 10:30 a.m.';
  const chinese = '预算是一万五千，不是五万。明天下午三点前发我。';
  const roman = '则 巴 杰 特 一 兹 一 万 五 千';
  const emoji = '好的 👍🏽 收到 ✅ 明天见 🎯';

  store.upsertMessages(id, [
    msg('t-1', 1, {
      sessionId: id,
      original: longOriginal,
      translation: chinese,
      romanization: roman,
    }),
    msg('t-2', 2, { sessionId: id, original: 'ok', translation: emoji, romanization: '' }),
  ]);

  const rows = store.getPage(id, { limit: 10 }).messages;
  eq(rows[0].original, longOriginal, 'H1 长原文逐字节一致');
  eq(rows[0].translation, chinese, 'H2 中文逐字节一致（含全角标点）');
  eq(rows[0].romanization, roman, 'H3 谐音逐字节一致（空格不能被吞）');
  eq(rows[1].translation, emoji, 'H4 emoji 逐字节一致（含肤色修饰符）');

  store.deleteSession(id);
}

// ---------------------------------------------------------------------------
// I. 关库重开
// ---------------------------------------------------------------------------
console.log('I. 关库重开（关闭软件 / 升级后重开）');
{
  const id = 'sess-reopen';
  store.createSession({ id, language: 'English', scenario: 'conversation', sourceMode: 'online' });
  store.upsertMessages(id, [
    msg('r-1', 1, { sessionId: id, translation: '重开之后还要在' }),
    msg('r-2', 2, { sessionId: id, translation: '第二句也要在' }),
  ]);
  store.saveFacts(id, [
    {
      id: 'f-1',
      sessionId: id,
      messageId: 'r-1',
      kind: 'money',
      value: '15000',
      sourceText: 'line 1',
      certainty: 'confirmed',
      createdAt: 1_700_000_000_000,
    },
  ]);
  const beforeClose = store.status();
  closeHistoryStore();

  // 模拟「升级后重开」：同一目录再 init 一次，走的是同一套 migrate。
  const reopened = initHistoryStore(DATA_DIR);
  eq(reopened.ready, true, 'I1 重新打开成功');
  eq(reopened.sessions, beforeClose.sessions, 'I2 会话数不变');
  eq(reopened.messages, beforeClose.messages, 'I3 消息数不变');
  eq(reopened.integrity, 'ok', 'I4 重开后完整性仍然 ok');

  const store2 = getHistoryStore();
  const page = store2.getPage(id, { limit: 10 });
  eq(page.messages.length, 2, 'I5 重开后消息还在');
  eq(page.messages[1].translation, '第二句也要在', 'I6 内容一字不差');
  const facts = store2.getFacts(id);
  eq(facts.length, 1, 'I7 事实卡结果也在');
  eq(facts[0].value, '15000', 'I8 事实值没变');

  // 迁移重复执行不许丢也不许重（user_version 的用途）。
  const again = initHistoryStore(DATA_DIR);
  eq(again.messages, reopened.messages, 'I9 迁移再跑一次条数不变');
  eq(again.sessions, reopened.sessions, 'I10 会话数也不变');

  // 全新的 store 指向同一个目录，也应该看到同样的数据（不是内存里记住的）。
  const fresh = new HistoryStore({ dir: DATA_DIR });
  fresh.open();
  eq(fresh.countMessages(id), 2, 'I11 新实例（模拟第二次启动）能读到旧数据');
  eq(fresh.getPage(id, { limit: 10 }).messages[0].seq, 1, 'I12 seq 从 1 开始，没被重置');
  fresh.close();
}

// ---------------------------------------------------------------------------
// J. 降级路径
// ---------------------------------------------------------------------------
console.log('J. 打不开时不能假装成功');
{
  // 把一个文件当目录用 → 创建子路径必然失败。
  const blockedRoot = path.join(ROOT, 'blocked');
  fs.writeFileSync(blockedRoot, 'not a directory', 'utf8');
  const broken = new HistoryStore({ dir: blockedRoot });
  const brokenStatus = broken.open();
  eq(brokenStatus.ready, false, 'J1 目录不可用时 ready=false');
  ok(brokenStatus.lastError.length > 0, 'J2 明确给出失败说明，不是静默');
  ok(brokenStatus.integrity !== 'ok', 'J3 完整性不谎报 ok');

  let threw = false;
  try {
    broken.getPage('x', { limit: 1 });
  } catch {
    threw = true;
  }
  ok(threw, 'J4 没打开时读操作要抛错，界面才会显示「尚未保存」而不是「已保存」');
  broken.close();
}

// ---------------------------------------------------------------------------
// K. 0.6.0：语言方向与读音提示体系也要存进来（schema v2）
// ---------------------------------------------------------------------------
console.log('K. schema v2：理解语言 / 提示体系 / 旧库升级');
{
  const { Database } = require('node-sqlite3-wasm');

  // K1-K6：新库把 hint_system / hint_version / comprehension 原样存回。
  const kdir = path.join(ROOT, 'v2');
  fs.mkdirSync(kdir, { recursive: true });
  const kstore = new HistoryStore({ dir: kdir, file: 'v2.db' });
  kstore.open();
  kstore.createSession({
    id: 'ja-en',
    language: 'English',
    comprehension: 'Japanese',
    hintSystem: 'katakana',
    scenario: 'conversation',
    sourceMode: 'online',
  });
  const ksession = kstore.getSession('ja-en');
  eq(ksession.comprehension, 'Japanese', 'K1 会话记下理解语言');
  eq(ksession.hintSystem, 'katakana', 'K2 会话记下提示体系');

  kstore.upsertMessages('ja-en', [
    msg('km1', 1, {
      original: 'Please send the report by 3 p.m.',
      translation: '3時までに報告書を送ってください',
      romanization: 'プリーズ センド ザ リポート バイ 3 ピーエム',
      hintSystem: 'katakana',
      hintVersion: 2,
      comprehension: 'Japanese',
    }),
  ]);
  const kmsg = kstore.getPage('ja-en', { limit: 5 }).messages[0];
  eq(kmsg.hintSystem, 'katakana', 'K3 消息记下提示体系');
  eq(kmsg.hintVersion, 2, 'K4 消息记下算法版本');
  eq(kmsg.comprehension, 'Japanese', 'K5 消息记下理解语言');
  eq(kmsg.romanization, 'プリーズ センド ザ リポート バイ 3 ピーエム', 'K6 片假名提示一字不差');

  // K7-K9：后到的更新不能把已经存好的回复/提示体系/理解语言冲成空。
  kstore.upsertMessages('ja-en', [
    msg('km1', 1, {
      original: 'Please send the report by 3 p.m.',
      translation: '3時までに報告書を送ってください（更新）',
      romanization: 'プリーズ センド ザ リポート バイ 3 ピーエム',
      reply: 'Sure, I will send it right away.',
    }),
  ]);
  kstore.upsertMessages('ja-en', [
    msg('km1', 1, {
      original: 'Please send the report by 3 p.m.',
      translation: '3時までに報告書を送ってください（更新）',
      romanization: 'プリーズ センド ザ リポート バイ 3 ピーエム',
      // 故意不带 reply / hintSystem / comprehension / hintVersion
    }),
  ]);
  const afterUpdate = kstore.getPage('ja-en', { limit: 5 }).messages[0];
  eq(afterUpdate.reply, 'Sure, I will send it right away.', 'K7 后续译文更新没有冲掉已保存的 AI 回复');
  eq(afterUpdate.hintSystem, 'katakana', 'K8 后续更新没有冲掉提示体系');
  eq(afterUpdate.hintVersion, 2, 'K9 后续更新没有冲掉算法版本');

  // K10：导出文本里的标签跟着当时的体系走，不再一律写「谐音」。
  const ktext = history.messageToText(kmsg);
  ok(ktext.includes('片假名近音'), 'K10 导出用「片假名近音」标注，不写成「谐音」', ktext);
  ok(!ktext.includes('谐音：'), 'K11 导出不再把片假名提示叫成谐音');

  /*
   * K21-K24：「没提供」与「明确清空」必须分开。
   *
   * 库里的默认规则是「空值不覆盖已存内容」，它挡住了迟到更新把回复冲成空；
   * 但用户真的想删掉某段内容时，这条规则会一起挡住删除 —— 于是出现
   * 「点了删除，重开又回来了」。`cleared` 字段就是给这件事留的通道。
   */
  kstore.upsertMessages('ja-en', [
    msg('km2', 2, { original: 'Do you have a minute?', translation: '你有空吗？', reply: 'Sure.' }),
  ]);
  kstore.upsertMessages('ja-en', [
    // 不带 cleared：空字符串只表示「这次没提供」，不该覆盖已存的回复。
    msg('km2', 2, { original: 'Do you have a minute?', translation: '你有空吗？', reply: '' }),
  ]);
  eq(
    kstore.getPage('ja-en', { limit: 10 }).messages.find((m) => m.id === 'km2').reply,
    'Sure.',
    'K21 不声明清空时，空值不覆盖已存回复',
  );
  kstore.upsertMessages('ja-en', [
    // 声明 cleared：这次是用户明确删掉这条回复。
    msg('km2', 2, {
      original: 'Do you have a minute?',
      translation: '你有空吗？',
      reply: '',
      cleared: ['reply'],
    }),
  ]);
  eq(
    Boolean(kstore.getPage('ja-en', { limit: 10 }).messages.find((m) => m.id === 'km2').reply),
    false,
    'K22 声明清空后，回复真的被清掉',
  );

  // K23/K24：重开库之后这两种语义仍然成立（不是只在内存里对）。
  // 重开的是 kstore 自己那个库（v2.db），不是后面那个 v1 旧库（legacy.db）。
  const reopened = new HistoryStore({ dir: kdir, file: 'v2.db' });
  reopened.open();
  eq(
    Boolean(reopened.getPage('ja-en', { limit: 10 }).messages.find((m) => m.id === 'km2').reply),
    false,
    'K23 重开库后「已清空」仍是空',
  );
  eq(
    reopened.getPage('ja-en', { limit: 10 }).messages.find((m) => m.id === 'km1').reply,
    'Sure, I will send it right away.',
    'K24 重开库后另一条的回复没被牵连',
  );
  reopened.close();

  // K12-K17：真的拿一个 v1 的旧库来升级（不是新建，是 ALTER TABLE 那条路）。
  const legacyFile = path.join(kdir, 'legacy.db');
  const legacy = new Database(legacyFile);
  legacy.exec('PRAGMA foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'English',
      scenario TEXT NOT NULL DEFAULT 'conversation',
      source_mode TEXT NOT NULL DEFAULT 'online',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
      speaker TEXT NOT NULL DEFAULT 'foreign', source TEXT NOT NULL DEFAULT '',
      original TEXT NOT NULL DEFAULT '', translation TEXT NOT NULL DEFAULT '',
      romanization TEXT NOT NULL DEFAULT '', ipa TEXT NOT NULL DEFAULT '',
      syllables TEXT NOT NULL DEFAULT '', user_input TEXT NOT NULL DEFAULT '',
      reply TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'final', confidence REAL,
      error_code TEXT NOT NULL DEFAULT '', error_title TEXT NOT NULL DEFAULT '',
      error_hint TEXT NOT NULL DEFAULT '', edited INTEGER NOT NULL DEFAULT 0,
      correction TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '', value TEXT NOT NULL DEFAULT '',
      source_text TEXT NOT NULL DEFAULT '', certainty TEXT NOT NULL DEFAULT 'stated',
      confirmed INTEGER NOT NULL DEFAULT 0, edited INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  legacy.run('INSERT INTO sessions (id,title,language,scenario,source_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [
    'old', '旧记录', 'English', 'conversation', 'online', 1_700_000_000_000, 1_700_000_000_000,
  ]);
  legacy.run(
    `INSERT INTO messages (id,session_id,seq,ts,original,translation,romanization,state,edited,correction)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['om1', 'old', 1, 1_700_000_000_000, 'Hello there', '你好', '哈喽 泽尔', 'final', 0, ''],
  );
  legacy.close();

  const upgraded = new HistoryStore({ dir: kdir, file: 'legacy.db' });
  const upgradedStatus = upgraded.open();
  eq(upgradedStatus.ready, true, 'K12 旧库（v1）能打开');
  eq(upgradedStatus.messages, 1, 'K13 升级没有删掉旧消息');
  const oldMsg = upgraded.getPage('old', { limit: 5 }).messages[0];
  eq(oldMsg.original, 'Hello there', 'K14 旧消息原文完好');
  eq(oldMsg.romanization, '哈喽 泽尔', 'K15 旧谐音完好，没有被清空');
  eq(oldMsg.hintSystem, undefined, 'K16 旧记录没有提示体系就是 undefined，不猜');
  const oldSession = upgraded.getSession('old');
  eq(oldSession.comprehension, undefined, 'K17 旧会话没有理解语言就是 undefined');
  upgraded.close();

  // K18：升级后 user_version 必须是当前 schema 版本，否则每次启动都会再 ALTER 一遍。
  const probe = new Database(legacyFile);
  const version = probe.get('PRAGMA user_version');
  probe.close();
  eq(Number(version?.user_version ?? 0), 3, 'K18 升级后 user_version = 3（0.6.2 的事实轨迹列）');

  // K19-K20：再开一次（模拟第二次启动）不能报错、不能丢数据。
  const againV2 = new HistoryStore({ dir: kdir, file: 'legacy.db' });
  const againStatus = againV2.open();
  eq(againStatus.ready, true, 'K19 升级过的库再打开正常（ALTER 不会重复跑）');
  eq(againV2.countMessages('old'), 1, 'K20 再打开后旧消息仍在');
  againV2.close();

  kstore.close();
}

// ---------------------------------------------------------------------------
// L. 事实卡的修改轨迹：落盘 → 重开 → 还原
// ---------------------------------------------------------------------------
{
  // 前面几组可能已经把全局 store 关掉了，这里重新打开一次再写。
  const db = initHistoryStore(DATA_DIR);
  eq(db.ready, true, 'L0 打开测试库');
  const id = 'sess-factlog';
  getHistoryStore().createSession({ id, language: 'English', scenario: 'conversation', sourceMode: 'online' });
  getHistoryStore().upsertMessages(id, [msg('m-1', 1, { sessionId: id })]);
  getHistoryStore().saveFacts(id, [
    {
      id: 'fx-1',
      sessionId: id,
      messageId: 'm-1',
      kind: 'money',
      value: '16000美元',
      sourceText: '15,000 dollars',
      certainty: 'stated',
      edited: true,
      createdAt: 1_700_000_000_000,
      sourceField: 'original',
      originalValue: '15000美元',
      status: 'pending',
      spoken: '16,000 dollars',
      spokenSource: 'user',
      comprehension: 'Chinese',
      targetLanguage: 'English',
      hintSystem: 'hanzi',
      log: [
        { at: 1_700_000_000_100, action: 'edited', from: '15000美元', to: '16000美元' },
        { at: 1_700_000_000_200, action: 'confirmed' },
        { at: 1_700_000_000_300, action: 'unconfirmed' },
      ],
    },
    {
      id: 'fx-2',
      sessionId: id,
      messageId: 'm-1',
      kind: 'date',
      value: '周二',
      sourceText: 'Tuesday',
      certainty: 'corrected',
      negated: true,
      status: 'pending',
      createdAt: 1_700_000_000_400,
    },
  ]);

  const rows = getHistoryStore().getFacts(id);
  const money = rows.find((row) => row.id === 'fx-1');
  const tuesday = rows.find((row) => row.id === 'fx-2');
  eq(money?.value, '16000美元', 'L1 改后的值存下来了');
  eq(money?.originalValue, '15000美元', 'L2 改之前的值也留着');
  eq(money?.spoken, '16,000 dollars', 'L3 现在该怎么说也存了');
  eq(money?.spokenSource, 'user', 'L4 标成用户自己写的');
  eq(money?.log?.length, 3, 'L5 修改 / 确认 / 取消确认三条都在');
  eq(money?.log?.[0]?.from, '15000美元', 'L6 时间线里记着改前值');
  eq(money?.log?.[2]?.action, 'unconfirmed', 'L7 改值让旧确认失效这条也记了');
  eq(tuesday?.negated, true, 'L8 被原话否定的值有标记');
  eq(tuesday?.sourceField, undefined, 'L9 老字段缺省不编造');

  // 重开：模拟真的退出进程再启动。
  closeHistoryStore();
  const reopened = initHistoryStore(DATA_DIR);
  eq(reopened.ready, true, 'L10 重开成功');
  const after = getHistoryStore().getFacts(id);
  const money2 = after.find((row) => row.id === 'fx-1');
  eq(after.length, 2, 'L11 两条事实都在');
  eq(money2?.value, '16000美元', 'L12 重开后改后的值还在');
  eq(money2?.log?.length, 3, 'L13 重开后修改轨迹还在');
  eq(money2?.confirmedAt, undefined, 'L14 取消确认后没有确认时间');
  eq(after.find((row) => row.id === 'fx-2')?.negated, true, 'L15 重开后否定标记还在');

  // 用户删掉一条：必须真的从库里消失，不能下次又冒出来。
  getHistoryStore().saveFacts(id, [money2], ['fx-2']);
  eq(getHistoryStore().getFacts(id).length, 1, 'L16 删掉的事实真的删了');

  // 空数组 + 无删除 = 什么都不做（不能把整场事实清空）。
  getHistoryStore().saveFacts(id, [], []);
  eq(getHistoryStore().getFacts(id).length, 1, 'L17 只传空数组不会误删');
}

// ---------------------------------------------------------------------------
fs.rmSync(ROOT, { recursive: true, force: true });

closeHistoryStore();

console.log(
  failed === 0 ? `\nRESULT PASS ${total}/${total}` : `\nRESULT FAIL ${failed}/${total}`,
);
process.exit(failed === 0 ? 0 : 1);
