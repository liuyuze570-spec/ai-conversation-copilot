/**
 * 「关键事实确认卡」的模型侧：补规则做不了的字段 + 生成确认句。
 *
 * 两个原则：
 * 1. **不新增依赖**：全部复用 `getLLM()`（用户已经配好的那家国内服务商）。
 * 2. **输出一律不可信**：拿回来先过 `validateFacts()`（类型 / 长度 / 出处），
 *    确认句还要过「不许出现事实之外的新数字」这一关。
 */

import { logger } from './logger';
import { getLLM } from './ai-service';
import { extractJson } from '../services/llm/openai-compatible';
import {
  FACT_KINDS,
  FACT_LABELS,
  checkSentenceAgainstFacts,
  factsForConfirm,
  introducesNewNumbers,
  planConfirmSentence,
  validateFacts,
  type FactDraft,
  type FactItem,
} from '../shared/facts';

/** 模型被允许说的话：只转写，不推断、不补全。 */
const EXTRACT_SYSTEM = `你在做一件事：从一句外语对话里，把**对方明确说出来的**关键事实抄下来，供说话人当场核对。

只允许这几种类型：
${FACT_KINDS.map((kind) => `- ${kind}（${FACT_LABELS[kind]}）`).join('\n')}

铁律（违反任意一条都算失败）：
1. sourceText 必须是【原话】里逐字存在的片段，一个字都不能改、不能翻译、不能补标点。
2. 不许推断。原话没说地点，就不要给 place；没说负责人，就不要给 owner。
3. 保留原来的确定程度：原话说"可能周五"，certainty 必须是 "uncertain"，value 里也要保留"可能"。
   原话说"不是三点，是四点"，那是更正，certainty = "corrected"，value 取更正后的"四点"。
4. 相对时间（明天、下周、tonight）原样保留，**不要**换算成具体日期。
5. value 用简体中文，短，不超过 30 个字；sourceText 用原话原文。
6. 没有明确事实就返回空数组，不要硬凑。

只输出 JSON，形如：
{"facts":[{"kind":"time","value":"明天下午三点","sourceText":"tomorrow at 3 pm","certainty":"stated"}]}`;

/** 统一取 chat：模拟实现没有它，就退回 complete（演示模式仍然能跑通流程）。 */
async function chatWith(
  llm: ReturnType<typeof getLLM>,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  temperature: number,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof llm.chat === 'function') {
    return llm.chat(messages, temperature, { json: true }, signal);
  }
  // 演示模式 / 老实现：把 system + user 拼成一段交给 complete。
  return llm.complete(messages.map((message) => message.content).join('\n\n'));
}

export async function extractFactsWithModel(
  input: {
    originalText: string;
    translatedText?: string;
    language: string;
  },
  options: { signal?: AbortSignal } = {},
): Promise<FactDraft[]> {
  const llm = getLLM();
  const user = [
    `对话语言：${input.language}`,
    `原话：${input.originalText}`,
    input.translatedText ? `参考译文（只用来理解，sourceText 必须取原话）：${input.translatedText}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await chatWith(
    llm,
    [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: user },
    ],
    0.1,
    options.signal,
  );

  const parsed = extractJson(raw);
  const list = (parsed as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(list)) {
    logger.warn('Facts', `model returned unexpected shape (${typeof parsed})`);
    return [];
  }

  // 先按「只要原话片段」收紧：模型经常把译文片段当 sourceText 交回来，
  // 那种片段在字幕的原话里找不到，校验会整条丢掉。
  const drafts: FactDraft[] = [];
  for (const rawItem of list.slice(0, 12)) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, unknown>;
    const kind = typeof item.kind === 'string' ? item.kind : '';
    const value = typeof item.value === 'string' ? item.value.trim() : '';
    const sourceText = typeof item.sourceText === 'string' ? item.sourceText.trim() : '';
    if (!kind || !value || !sourceText) continue;
    if (!(FACT_KINDS as readonly string[]).includes(kind)) continue;
    drafts.push({
      kind: kind as FactDraft['kind'],
      value,
      sourceText,
      sourceField: 'original',
      certainty:
        item.certainty === 'uncertain' || item.certainty === 'corrected'
          ? (item.certainty as FactDraft['certainty'])
          : 'stated',
    });
  }
  return drafts;
}

/** 把模型给的候选 + 规则给的候选合起来，统一校验成可上屏的事实。 */
export function toItems(
  candidates: unknown[],
  source: { itemId: string; originalText: string; translatedText?: string; roundIndex: number },
  idPrefix: string,
): FactItem[] {
  return validateFacts(candidates, source, (index) => `${idPrefix}-${index}`);
}

/** 生成确认句时给模型的约束。释义语言随「理解语言」变，不能写死中文。 */
function confirmSystem(comprehensionLabel: string): string {
  return `你要把几条已经核对过的事实，写成一句**自然的确认用语**，让说话人直接对对方念出来。

铁律：
1. 只能用给出的这几条事实，**不许增加**任何新的承诺、时间、地点、金额、人数或条件。
2. 不要加寒暄、解释、理由；就是一句确认。
3. sentence 必须是用户指定的对话语言，口语、简短、能直接说出口（不超过 40 个词）。
4. meaning 是这句话用**${comprehensionLabel}**说的意思，直译即可，不要润色成另一句。
5. 标了「原话否定」的行是**作废的旧值**，不许出现在 sentence 里，也不许当成当前信息。
6. 标了「用户已改」的行，sentence 里必须用**改后的值**；不能把原话里的旧数字、旧日期抄回去。
7. 事实里带"待核对"的，用"…对吗？"这种确认语气；带"已更正"的，用"我确认一下，是……"这种纠正语气。

只输出 JSON：{"sentence":"...","meaning":"..."}`;
}

export interface ConfirmResult {
  ok: boolean;
  sentence: string;
  chinese: string;
  message?: string;
  /** true = 没有走模型，按用户勾选的原文片段直接拼的。 */
  local?: boolean;
  /** 哪几条改过的信息推不出目标语言说法（界面据此标「补说法」）。 */
  blocked?: { id: string; value: string; sourceText: string; reason: string }[];
}

const COMPREHENSION_LABEL: Record<string, string> = {
  Chinese: '简体中文',
  Japanese: '日语',
  English: '英语',
  Russian: '俄语',
  Korean: '韩语',
};

export async function composeConfirmation(
  input: { facts: FactItem[]; language: string; comprehension?: string },
  options: { signal?: AbortSignal } = {},
): Promise<ConfirmResult> {
  if (!input.facts.length) {
    return { ok: false, sentence: '', chinese: '', message: '先选一条要确认的信息' };
  }
  const comprehension = input.comprehension ?? 'Chinese';
  /*
   * 本地拼句作为**兜底**先算好。
   *
   * 演示模式（mock）没有真模型，模型那条路只会回一段非 JSON 文本；真模型
   * 断网/超时也会失败。确认句恰恰是现场最不能卡住的一步。
   *
   * 但兜底不再「拿原话顶上」：用户改过值之后，本地只在能机械推导出目标
   * 语言说法时才出句子，否则返回 blocked，让用户自己补一句 —— 旧英文配
   * 新中文比不给句子更危险。
   */
  const plan = planConfirmSentence(input.facts, input.language, comprehension);
  const localResult: ConfirmResult | null = plan.ok
    ? { ok: true, sentence: plan.sentence, chinese: plan.meaning, local: true }
    : null;
  const blocked = plan.blocked.length ? plan.blocked : undefined;

  const llm = getLLM();
  if (llm.id === 'mock') {
    return (
      localResult ?? {
        ok: false,
        sentence: '',
        chinese: '',
        message: plan.message ?? '生成失败，请重试',
        blocked,
      }
    );
  }

  const factsText = factsForConfirm(input.facts);
  let raw = '';
  try {
    raw = await chatWith(
      llm,
      [
        {
          role: 'system',
          content: confirmSystem(COMPREHENSION_LABEL[comprehension] ?? '简体中文'),
        },
        {
          role: 'user',
          content: [
            `对话语言：${input.language}`,
            `释义语言：${COMPREHENSION_LABEL[comprehension] ?? '简体中文'}`,
            '要确认的事实：',
            factsText,
            input.facts.some((fact) => fact.certainty === 'uncertain') ? '注意：其中有待核对的信息。' : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      0.3,
      options.signal,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logger.warn('Facts', 'confirm via model failed, using local sentence');
    if (localResult) return localResult;
    return {
      ok: false,
      sentence: '',
      chinese: '',
      message: plan.message ?? '生成失败，请重试',
      blocked,
    };
  }

  const parsed = (extractJson(raw) ?? {}) as { sentence?: unknown; chinese?: unknown };
  const sentence = typeof parsed.sentence === 'string' ? parsed.sentence.trim() : '';
  // 兼容老模型只回 chinese 的情况；新提示词统一叫 meaning。
  const chinese =
    typeof parsed.chinese === 'string'
      ? parsed.chinese.trim()
      : typeof (parsed as { meaning?: unknown }).meaning === 'string'
        ? String((parsed as { meaning?: unknown }).meaning).trim()
        : '';
  if (!sentence) {
    if (localResult) return localResult;
    return {
      ok: false,
      sentence: '',
      chinese: '',
      message: plan.message ?? '模型没有给出确认句，请重试一次',
      blocked,
    };
  }
  if (sentence.length > 300 || chinese.length > 300) {
    if (localResult) return localResult;
    return { ok: false, sentence: '', chinese: '', message: '生成的句子太长，请重试一次', blocked };
  }
  // 关键闸门：句子里出现了事实之外的数字 = 模型自己加了新信息，不能给用户。
  if (introducesNewNumbers(`${sentence} ${chinese}`, factsText)) {
    logger.warn('Facts', 'confirm sentence introduced new numbers, rejected');
    if (localResult) return localResult;
    return {
      ok: false,
      sentence: '',
      chinese: '',
      message: plan.message ?? '这句话里出现了你选的事实之外的新信息，已拦下。请再点一次「帮我确认」。',
      blocked,
    };
  }
  /*
   * 第二道闸：改过之后旧值不许留下、新值不许漏。
   *
   * 模型看到「15,000 dollars（原话）+ 16000 美元（用户改的）」时，很自然
   * 会把原话的 15,000 抄进英文句子 —— 而释义里是新值。用户念出来就是错的。
   */
  const gate = checkSentenceAgainstFacts(sentence, chinese, input.facts);
  if (!gate.ok) {
    logger.warn('Facts', 'confirm sentence failed fact gate, rejected');
    if (localResult) return localResult;
    return {
      ok: false,
      sentence: '',
      chinese: '',
      message: plan.blocked.length ? (plan.message ?? gate.message) : gate.message,
      blocked,
    };
  }
  return { ok: true, sentence, chinese };
}
