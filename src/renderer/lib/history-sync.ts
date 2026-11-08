import type { ConversationItem } from '../../shared/types';
import type { HistoryFact, HistoryMessage, HistoryMessageState } from '../../shared/history';
import { attachPendingReply, describeHistoryError } from '../../shared/history';
import { useConversationStore } from '../stores/conversation';
import { useFactsStore } from '../stores/facts';
import { useHistoryStore } from '../stores/history';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';

/**
 * 把「界面上正在流动的字幕」写进本地数据库。
 *
 * 只有这一个写入者。以前是 `useSessions` 在 items 变化后 debounce 800ms 调
 * `saveCurrent`，把**整个数组**塞进一个内存对象 —— 于是：
 *  - 关掉窗口就没了（内存）；
 *  - 数组被 `slice(0, 50)` 截断，第 51 段把最老的一段挤掉；
 *  - 「保存」其实只是覆盖内存，没有任何回执，界面无从知道到底存没存。
 *
 * 现在的规则：
 *  1. **每条消息一个 id**，转写先到先写，译文后到用同一个 id 覆盖同一行；
 *  2. 写入是**小批量 + debounce 300ms**，不是每敲一个字就落盘；
 *  3. 只有拿到主进程回执才把界面标成「已保存」，失败就标「尚未保存」并允许重试；
 *  4. 新建会话前先把待写队列冲干净，绝不用「当前内存里的一小部分」覆盖旧会话。
 */

const FLUSH_DELAY_MS = 300;
const PARTIAL_FLUSH_DELAY_MS = 900;
const MAX_RETRY_DELAY_MS = 30_000;

let started = false;
let unsubscribers: (() => void)[] = [];

let sessionId: string | null = null;
/** 每条消息「已经交给主进程」的样子，用来判断有没有变化、以及补写 reply。 */
const known = new Map<string, HistoryMessage>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
/**
 * 写入串行队列。
 *
 * 以前用一个布尔 `inFlight`：上一批还在写的时候，第二个人调 `flushHistory()`
 * 会立刻拿到 false —— 而调用方（切会话、新建）拿到 false 后照样清场，
 * 于是那几条「还没写完」的消息就只留在内存里，被下一次清屏顺手扔掉。
 * 现在排队：谁调用都等前一批落盘，再把自己的那一批写进去。
 */
let chain: Promise<unknown> = Promise.resolve();
let failures = 0;
/**
 * 待写的 AI 回复。
 *
 * 0.6.0 的写法是「先把回复塞进 known、再把两个变量清空，然后才发数据库」，
 * 于是只要这一次 `historyUpsert` 失败：known 里已经是「带回复」的样子，
 * `collect()` 认为这行没变化不再重发；`pendingReplyText` 也已经清空，
 * 重试时没有回复可补 —— 回复就这么永久丢了，而界面上还写着「尚未保存」。
 * 现在只在**拿到成功回执之后**才清，失败就原样留着。
 */
let pendingReply: { id: string; text: string } | null = null;

function nextSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `s-${Date.now().toString(36)}-${rand}`;
}

function messageStateOf(item: ConversationItem): HistoryMessageState {
  if (item.partial) return 'partial';
  const state = item.translationState;
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'pending') return 'pending';
  return 'final';
}

function toHistoryMessage(item: ConversationItem): HistoryMessage {
  const settings = useSettingsStore.getState().settings;
  /*
   * 采到这一句的**实际通道**，不是「对方说的就一定是系统声音」。
   *
   * 现场沟通模式（麦克风收对方）下，同一句外语是从麦克风进来的；一律写
   * `system` 会让用户在历史里看到「系统声音」，回头查「当时到底开了哪个
   * 设备」就查不出来。
   */
  const foreignChannel = item.audioSource ?? (settings.audio.sourceMode === 'onsite' ? 'mic' : 'system');
  return {
    id: item.id,
    sessionId: sessionId ?? '',
    seq: item.seq ?? 0,
    ts: item.timestamp,
    speaker: item.speaker,
    source: item.speaker === 'foreign' ? foreignChannel : 'mic',
    original: item.originalText,
    translation: item.translatedText ?? '',
    romanization: item.romanization ?? '',
    // 提示体系和理解语言跟着每条记录一起存。用户之后把「理解语言」从
    // 中文改成日语，旧记录仍然是「当时的汉字近音」，读回来不会被当成片假名。
    hintSystem: item.hintSystem,
    hintVersion: item.hintVersion,
    comprehension: item.comprehension ?? settings.nativeLanguage,
    syllables: undefined,
    state: messageStateOf(item),
    confidence: item.confidence,
    translationError: item.translationError,
    edited: false,
    correction: item.correction,
    /**
     * 用户**明确清空**的字段。
     *
     * 「没提供」（undefined）和「清空」（''）在数据库层是两件事：前者不该
     * 覆盖已存内容，后者必须真的写成空。目前界面上还没有清空某个字段的操作，
     * 这里先把通道留好 —— 否则将来加了「撤销纠正」也没法真的撤销。
     */
    cleared: item.clearedFields,
  };
}

function sameRow(a: HistoryMessage, b: HistoryMessage): boolean {
  return (
    a.original === b.original &&
    a.translation === b.translation &&
    a.romanization === b.romanization &&
    a.hintSystem === b.hintSystem &&
    a.hintVersion === b.hintVersion &&
    a.state === b.state &&
    a.correction === b.correction &&
    a.confidence === b.confidence &&
    // 「明确清空」和「没变化」不是一回事：不比较这一项，清空请求就发不出去。
    (a.cleared ?? []).join(',') === (b.cleared ?? []).join(',')
  );
}

function ensureSession(): string {
  if (sessionId) return sessionId;
  const settings = useSettingsStore.getState().settings;
  sessionId = nextSessionId();
  known.clear();
  pending.clear();
  void window.copilot.historyEnsureSession({
    id: sessionId,
    language: settings.targetLanguage,
    scenario: settings.scenarioMode,
    sourceMode: settings.audio.sourceMode,
    comprehension: settings.nativeLanguage,
    hintSystem: settings.hintSystem,
  });
  return sessionId;
}

function schedule(delay = FLUSH_DELAY_MS) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushHistory();
  }, delay);
}

/** 收集「和上次写过的样子不一样」的消息。 */
function collect(): HistoryMessage[] {
  const items = useConversationStore.getState().items;
  const out: HistoryMessage[] = [];
  for (const item of items) {
    if (!item.originalText.trim() && !item.partial) continue;
    const row = toHistoryMessage(item);
    const before = known.get(item.id);
    if (before && sameRow(before, row)) continue;
    out.push(row);
  }
  return out;
}

/**
 * 立刻把待写内容刷到数据库。
 *
 * 返回是否成功 —— 「新建会话」「切换会话」这类动作会等它：只要没写成功就
 * **不要切**，否则这些字只留在内存里，而界面上还写着「尚未保存」。
 *
 * 调用会排队，不会因为「上一批在写」就假装成功。
 */
export function flushHistory(): Promise<boolean> {
  const run = chain.then(runFlush, runFlush);
  // chain 只用来排队，不关心结果：一次失败不能让后面的写入全被跳过。
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runFlush(): Promise<boolean> {
  const rows = collect();
  const reply = pendingReply;
  if (!rows.length && !reply) {
    useHistoryStore.getState().setPendingCount(0);
    return true;
  }

  const id = ensureSession();
  // 并回复这件事有纯函数版本（shared/history.attachPendingReply），
  // 单测直接跑它，不用把整个渲染进程拖进来。
  const planned = attachPendingReply(rows, known, reply);
  const patchRows = planned.rows;
  const replySent = planned.replySent;
  if (!patchRows.length) {
    // 只有一条回复、但那一行还没进库：留着下次补，不能假装写完。
    useHistoryStore.getState().setPendingCount(0);
    return true;
  }

  const store = useHistoryStore.getState();
  store.setPendingCount(patchRows.length);
  store.setSaveState('saving');
  try {
    const result = await window.copilot.historyUpsert({ sessionId: id, messages: patchRows });
    if (result.ok) {
      // 只有拿到回执才更新「已保存的样子」，失败时 known 保持旧值，
      // 下一次 collect() 才能重新把这些行收进来。
      for (const row of patchRows) known.set(row.id, row);
      if (replySent && pendingReply === reply) pendingReply = null;
      failures = 0;
      store.setSaveState('saved', { at: Date.now() });
      store.setPendingCount(collect().length);
      return true;
    }
    failures += 1;
    store.setSaveState('failed', { error: result.error });
    store.setPendingCount(patchRows.length);
    schedule(Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(failures, 5)));
    return false;
  } catch (error) {
    failures += 1;
    store.setSaveState('failed', { error: describeHistoryError(error) });
    schedule(Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(failures, 5)));
    return false;
  } finally {
    pending.clear();
  }
}

/** 用户点了「重试保存」。 */
export async function retrySave(): Promise<boolean> {
  failures = 0;
  // 强制重发一次全部：上次失败时 known 里没有这些行。
  known.clear();
  return flushHistory();
}

/**
 * 开一段新会话。
 *
 * 先把旧的写干净 —— 顺序反了就会「新会话建好了，旧会话最后三句还没落盘」。
 * 返回 false 表示**这批没写成功，所以没有切**：调用方不要清屏、
 * 不要丢掉界面上的内容，让用户先看到「尚未保存」和「重试保存」。
 */
export async function startNewHistorySession(): Promise<boolean> {
  const ok = await flushHistory();
  if (!ok) return false;
  resetSessionIdentity();
  return true;
}

/**
 * 直接丢弃当前会话身份，不写任何东西。
 *
 * 只在数据已经被删掉（删除这段记录 / 清空全部）时用：这时候再 flush 会把
 * 刚删的内容又写回一个新会话里，等于删不掉。
 */
export function discardHistorySession(): void {
  resetSessionIdentity();
}

function resetSessionIdentity(): void {
  sessionId = null;
  known.clear();
  pending.clear();
  pendingReply = null;
  useHistoryStore.getState().setSaveState('idle');
}

/**
 * 打开一段已保存的记录后，后续字幕追加到**这一段**里。
 *
 * 为什么不新开一段：用户点开旧记录、然后继续说话，那是同一场对话的延续。
 * 新开一段会让「刚才看到的上下文」和「新说的话」分成两条记录。
 */
export function attachHistorySession(id: string, seed: ConversationItem[]): void {
  sessionId = id;
  known.clear();
  pending.clear();
  // 已经存在的行不重发（幂等，但没必要每次打开都写一遍）。
  for (const item of seed) {
    if (!item.originalText.trim()) continue;
    known.set(item.id, { ...toHistoryMessage(item), sessionId: id });
  }
  useHistoryStore.getState().setSaveState('idle');
}

export function currentHistorySessionId(): string | null {
  return sessionId;
}

/** 记录「AI 回复已经展示给用户了」。 */
export function recordReply(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const state = useUiStore.getState();
  const items = useConversationStore.getState().items.filter(
    (item) => item.speaker === 'foreign' && !item.partial,
  );
  const index = Math.max(0, (state.repliesRound ?? items.length) - 1);
  const target = items[index] ?? items[items.length - 1];
  if (!target) return;
  pendingReply = { id: target.id, text: trimmed };
  schedule(FLUSH_DELAY_MS);
}

/**
 * 事实卡也要落盘，而且要存**修改轨迹**。
 *
 * 只存 value 的话，重开记录只看到「16000美元」—— 原话是什么、改之前是什么、
 * 谁在哪一刻确认过、这条是不是被原话否定过，全都丢了。用户回头没法解释
 * 「我为什么这么理解」。
 */
const knownFactIds = new Set<string>();

export function recordFacts(): void {
  if (!sessionId) return;
  const items = useFactsStore.getState().items;
  if (!items.length && !knownFactIds.size) return;
  const settings = useSettingsStore.getState().settings;
  const facts: HistoryFact[] = items.map((item) => ({
    id: item.id,
    sessionId: sessionId as string,
    messageId: item.itemId,
    kind: String(item.kind),
    value: item.value,
    sourceText: item.sourceText ?? '',
    certainty: item.certainty ?? 'stated',
    confirmed: item.status === 'confirmed',
    edited: item.edited,
    createdAt: Date.now(),
    sourceField: item.sourceField,
    negated: item.negated,
    originalValue: item.originalValue,
    status: item.status,
    confirmedAt: item.confirmedAt,
    log: item.log,
    spoken: item.spoken,
    spokenSource: item.spokenSource,
    comprehension: settings.nativeLanguage,
    targetLanguage: settings.targetLanguage,
    hintSystem: settings.hintSystem,
  }));

  // 用户删掉的那几条要真的从库里删掉，否则下次打开又回来了。
  const current = new Set(facts.map((fact) => fact.id));
  const removedIds = [...knownFactIds].filter((id) => !current.has(id));

  useHistoryStore.getState().setFactSave('saving');
  void window.copilot
    .historySaveFacts({ sessionId, facts, removedIds })
    .then((result) => {
      if (!result?.ok) {
        // 事实卡自己报失败：不许被字幕的「已保存」盖掉。
        useHistoryStore.getState().setFactSave('failed', result?.error ?? null);
        return;
      }
      for (const id of removedIds) knownFactIds.delete(id);
      for (const fact of facts) knownFactIds.add(fact.id);
      useHistoryStore.getState().setFactSave('saved');
    })
    .catch(() => {
      useHistoryStore.getState().setFactSave('failed', null);
    });
}

/** 失败后手动重试：重发当前这一批（不改内容）。 */
export function retryFactSave(): void {
  recordFacts();
}

/** 应用启动时调一次（幂等）。 */
export function startHistorySync(): void {
  if (started) return;
  started = true;

  unsubscribers.push(
    useConversationStore.subscribe((state, prev) => {
      if (state.items === prev.items && state.marks === prev.marks) return;
      // 只有真的有内容才建会话：空白对话不该在库里留一行。
      if (!state.items.length) return;
      if (!sessionId) {
        // 第一句字幕到了 —— 会话在这一刻就有了稳定 id。
        ensureSession();
      }
      const hasPartial = state.items.some((item) => item.partial);
      schedule(hasPartial ? PARTIAL_FLUSH_DELAY_MS : FLUSH_DELAY_MS);
    }),
  );

  unsubscribers.push(
    useUiStore.subscribe((state, prev) => {
      if (state.suggestions === prev.suggestions) return;
      if (!state.suggestions.length) return;
      const first = state.suggestions[0]?.english;
      if (first) recordReply(first);
    }),
  );

  unsubscribers.push(
    useFactsStore.subscribe((state, prev) => {
      if (state.items === prev.items) return;
      recordFacts();
    }),
  );
}

export function stopHistorySync(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}

/** 界面上的「保存状态」文案（纯函数，方便单测）。 */
export function saveStateLabel(state: string, pendingCount: number): string {
  switch (state) {
    case 'saving':
      return '正在保存…';
    case 'pending':
      return pendingCount > 0 ? `待保存 ${pendingCount} 条` : '待保存';
    case 'saved':
      return '已保存';
    case 'failed':
      return '尚未保存';
    default:
      return '待保存';
  }
}
