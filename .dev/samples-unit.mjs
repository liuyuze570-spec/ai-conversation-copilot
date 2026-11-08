/**
 * 演示样例 / 离线翻译 / 确认句 / 待写回复（0.6.1 新增回归）。
 *
 * 用例来源是用户实测报的四个现象：
 *   1. `Please send the report by 3 p.m. tomorrow.` 不管理解语言选中文、日语
 *      还是英语，离线译文都只回「明天 / 下周」；
 *   2. 理解语言换成日语，字幕还是中文；
 *   3. 演示模式点「帮我确认」拿不到句子（mock 模型不会返回 JSON）；
 *   4. 保存失败时 AI 回复不进重试队列，回复直接丢。
 *
 * 这里逐条钉死，不写「看起来对」的断言：
 *   S1 三方向 × 三样例的译文必须逐字等于预置参考译文
 *   S2 同一句原文、不同理解语言 → 译文必须是不同语言（不许拿中文顶替）
 *   S3 非中文方向未收录的句子要明说「没有」，不许编
 *   S4 事实：被否定的旧值带 negated，更正后的新值不带
 *   S5 确认句只念「当前理解」，被否定的旧值不进句子，数字不许变
 *   S6 演示回复的释义跟着理解语言走
 *   S7 待写回复：并进批次 / 行还没进库时不假装成功 / 不改原数组
 *
 * 运行：node .dev/samples-unit.mjs
 */
import * as samples from '../dist/shared/samples.js';
import * as facts from '../dist/shared/facts.js';
import { translateOffline } from '../dist/services/mock/mock-translation.js';
import { MockLLM } from '../dist/services/mock/mock-llm.js';
import { attachPendingReply } from '../dist/shared/history.js';
import {
  findCustomReading,
  removeCustomReading,
  sanitizeCustomReadings,
  upsertCustomReading,
} from '../dist/shared/reading-dictionary.js';
import { buildHintPlan } from '../dist/services/pronunciation.js';

let passed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    return;
  }
  failures.push(`${label}${detail ? `  →  ${detail}` : ''}`);
}

function eq(label, actual, expected) {
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// --------------------------------------------------------------------------- //
console.log('S1 三个方向 × 三组样例：译文逐字等于参考译文');
{
  const dirs = ['zh-en', 'ja-en', 'en-ja'];
  for (const sample of samples.SAMPLE_CASES) {
    for (const dir of dirs) {
      const variant = sample.variants[dir];
      const comprehension = samples.DIRECTION_COMPREHENSION[dir];
      eq(
        `S1 ${sample.id}/${dir} 译文`,
        translateOffline(variant.original, comprehension),
        variant.translation,
      );
    }
  }
  // 用户实测那一句：必须是完整中文，不再是「明天 / 下周」。
  const time = samples.SAMPLE_CASES.find((s) => s.id === 'sample-time');
  const zh = translateOffline('Please send the report by 3 p.m. tomorrow.', 'Chinese');
  eq('S1b 用户实测句 → 中文', zh, time.variants['zh-en'].translation);
  check('S1c 不再是关键词拼接', !/明天 \/ 下周/.test(zh), zh);
}

console.log('S2 同一句原文，不同理解语言得到不同语言');
{
  const text = 'The budget is fifteen thousand, not fifty thousand.';
  const zh = translateOffline(text, 'Chinese');
  const ja = translateOffline(text, 'Japanese');
  check('S2 中文版是中文', /[\u4e00-\u9fa5]/.test(zh), zh);
  check('S2 日语版有假名（不是中文顶替）', /[\u3040-\u30ff]/.test(ja), ja);
  check('S2 日语版不是中文那一句', ja !== zh);
  check('S2 日语版带日语助词', /は|で|です/.test(ja), ja);
}

console.log('S3 非中文方向：没有预置译文就明说，不拿中文顶替');
{
  const out = translateOffline('Could you reschedule the kickoff call?', 'Japanese');
  check('S3 明说没有日语译文', out.includes('没有这句的日语译文'), out);
  check('S3 明说不拿中文顶替', out.includes('不拿中文顶替'), out);
  check('S3 原样保留原话，便于用户自己判断', out.includes('Could you reschedule'), out);

  const longZh = translateOffline('Could you reschedule the kickoff call?', 'Chinese');
  check('S3b 长句没有预置译文时不拼关键词', longZh.includes('没有这句的预置译文'), longZh);

  const shortZh = translateOffline('Thanks!', 'Chinese');
  // 短句现在走「整句短句」这一层，给的是完整译文而不是关键词。
  eq('S3c 短句给完整译文', shortZh, '谢谢。');
}

console.log('S4 三方向的事实：否定 / 当前理解分开');
{
  const moved = 'sample-moved';
  const budget = 'sample-budget';
  for (const sample of samples.SAMPLE_CASES) {
    for (const [dir, variant] of Object.entries(sample.variants)) {
      const drafts = facts.extractFactsWithRules({
        originalText: variant.original,
        translatedText: variant.translation,
      });
      if (sample.id === moved) {
        const old = drafts.find((d) => d.negated);
        const current = drafts.filter((d) => d.kind === 'date' && !d.negated);
        check(`S4 ${dir} 有一个被否定的日期`, Boolean(old), JSON.stringify(drafts));
        check(`S4 ${dir} 有当前有效的日期`, current.length >= 1);
        check(
          `S4 ${dir} 旧值不会同时被当成当前值`,
          !drafts.some((d) => d.negated && d.certainty !== 'corrected'),
        );
        continue;
      }
      if (sample.id === budget) {
        const old = drafts.find((d) => d.negated);
        check(`S4 ${dir} 金额有一条被否定`, Boolean(old), JSON.stringify(drafts));
        check(`S4 ${dir} 另一条金额是确定的`, drafts.some((d) => d.kind === 'money' && !d.negated));
        continue;
      }
      // 时间样例：只要抓到时间与日期，且「明天」不被换成年份
      check(`S4 ${dir} 有时间`, drafts.some((d) => d.kind === 'time'), JSON.stringify(drafts));
      check(`S4 ${dir} 有日期`, drafts.some((d) => d.kind === 'date'), JSON.stringify(drafts));
      check(
        `S4 ${dir} 没有编出具体年份`,
        !drafts.some((d) => /20\d\d/.test(d.value)),
      );
    }
  }
}

console.log('S5 确认句：只念当前理解，数字不变');
{
  const movedVariant = samples.SAMPLE_CASES.find((s) => s.id === 'sample-moved');
  const zh = movedVariant.variants['zh-en'];
  const drafts = facts.extractFactsWithRules({
    originalText: zh.original,
    translatedText: zh.translation,
  });
  const items = drafts.map((draft, index) => ({
    id: `f${index}`,
    kind: draft.kind,
    value: draft.value,
    sourceText: draft.sourceText,
    sourceField: draft.sourceField,
    negated: draft.negated,
    certainty: draft.certainty,
    status: 'pending',
    itemId: 'i1',
    roundIndex: 0,
    createdAt: 0,
  }));

  const cn = facts.buildConfirmSentence(items, 'English', 'Chinese');
  check('S5 中文释义句子生成', cn && cn.sentence.length > 0, JSON.stringify(cn));
  check('S5 句子里有周四/Thursday', /Thursday/.test(cn.sentence), cn.sentence);
  check('S5 句子里不出现被否定的周二', !/Tuesday/.test(cn.sentence), cn.sentence);
  // 句子里的每个数字都必须能在勾选的事实里找到（不许模型/拼接凭空加数字）。
  const allowed = new Set(
    items.flatMap((item) => `${item.value} ${item.sourceText}`.match(/\d+/g) ?? []),
  );
  const inSentence = cn.sentence.match(/\d+/g) ?? [];
  check(
    'S5 句子里的数字都来自勾选的事实',
    inSentence.every((n) => allowed.has(n)),
    `${inSentence.join(',')} vs ${[...allowed].join(',')}`,
  );
  check('S5 释义是中文', /[\u4e00-\u9fa5]/.test(cn.meaning), cn.meaning);

  const ja = facts.buildConfirmSentence(items, 'Japanese', 'Japanese');
  check('S5b 日语目标语言句子', /合っていますか/.test(ja.sentence), ja.sentence);

  // 只选被否定的旧值 → 没有可确认内容，返回 null（界面据此提示）
  const onlyOld = items.filter((item) => item.negated);
  eq('S5c 只选旧值时不生成句子', facts.buildConfirmSentence(onlyOld, 'English', 'Chinese'), null);
}

console.log('S6 演示回复的释义跟着理解语言');
{
  const llm = new MockLLM();
  const ja = await llm.generateReplies({
    context: 'Foreign: The meeting is not on Tuesday.',
    level: 'cet4',
    style: 'natural',
    length: 'short',
    mode: 'reply',
    language: 'English',
    comprehension: 'Japanese',
    hintSystem: 'katakana',
  });
  check('S6 日语理解 → 有日语释义', ja.every((d) => /[\u3040-\u30ff]/.test(d.meaning ?? '')), JSON.stringify(ja.map((d) => d.meaning)));
  check('S6 回复本体仍是英语', ja.every((d) => /^[\x20-\x7e]+$/.test(d.english)), JSON.stringify(ja.map((d) => d.english)));

  const en = await llm.generateReplies({
    context: 'Foreign: 会議は木曜日に変更になりました。',
    level: 'cet4',
    style: 'natural',
    length: 'short',
    mode: 'reply',
    language: 'Japanese',
    comprehension: 'English',
    hintSystem: 'romaji',
  });
  check('S6b 英语理解 → 释义是英语', en.every((d) => !/[\u4e00-\u9fa5]/.test(d.meaning ?? '')), JSON.stringify(en.map((d) => d.meaning)));

  const zh = await llm.generateReplies({
    context: 'Foreign: The meeting is not on Tuesday.',
    level: 'cet4',
    style: 'natural',
    length: 'short',
    mode: 'reply',
    language: 'English',
    comprehension: 'Chinese',
    hintSystem: 'hanzi',
  });
  check('S6c 中文理解 → 释义仍是中文', zh.every((d) => /[\u4e00-\u9fa5]/.test(d.meaning ?? d.chinese)));
}

console.log('S7 待写回复：并进批次、不提前判成功、不改原数组');
{
  const row = (id, reply) => ({
    id,
    sessionId: 's1',
    seq: 1,
    ts: 1,
    speaker: 'foreign',
    source: 'system',
    original: 'hello',
    translation: '你好',
    romanization: '',
    state: 'final',
    reply,
  });

  const batch = [row('a'), row('b')];
  const known = new Map([['b', row('b')]]);

  const inBatch = attachPendingReply(batch, known, { id: 'a', text: 'Sure.' });
  eq('S7 命中本批 → 带上回复', inBatch.replySent, true);
  eq('S7 回复写进去了', inBatch.rows.find((r) => r.id === 'a').reply, 'Sure.');
  eq('S7 原数组没被改', batch[0].reply, undefined);

  const fromKnown = attachPendingReply([], known, { id: 'b', text: 'OK.' });
  eq('S7 行不在本批但在已保存里 → 也能带上', fromKnown.replySent, true);

  const nothing = attachPendingReply([], new Map(), { id: 'zzz', text: 'Hi.' });
  eq('S7 行还没进库 → 不算带上（要留给下一次）', nothing.replySent, false);
  eq('S7 不算带上时不往批次里塞假行', nothing.rows.length, 0);

  // 已有回复的行再被回复一次，只有最新的那句生效
  const again = attachPendingReply([row('a', 'old')], new Map(), { id: 'a', text: 'new' });
  eq('S7 重复回复以最新一次为准', again.rows[0].reply, 'new');
}


console.log('S8 个人词表：用户填的读法优先，且不冒充专家核对');
{
  const list = upsertCustomReading([], { word: 'Nguyen', reading: '努伊恩', system: 'hanzi' });
  eq('S8 存一条', list.length, 1);
  eq('S8 读法', findCustomReading('nguyen', 'hanzi', list)?.reading, '努伊恩');
  eq('S8 别的体系不命中', findCustomReading('Nguyen', 'katakana', list), undefined);

  const replaced = upsertCustomReading(list, { word: 'NGUYEN', reading: '努因', system: 'hanzi' });
  eq('S8 同词同体系覆盖而不是新增', replaced.length, 1);
  eq('S8 覆盖后是最新读法', findCustomReading('Nguyen', 'hanzi', replaced)?.reading, '努因');

  const both = upsertCustomReading(replaced, { word: 'Nguyen', reading: 'グエン', system: 'katakana' });
  eq('S8 两种体系各存一条', both.length, 2);

  const cleaned = sanitizeCustomReadings([
    { word: '  ', reading: 'x', system: 'hanzi' },
    { word: 'K8s', reading: '', system: 'hanzi' },
    { word: 'K8s', reading: '케이에잇에스', system: 'nope' },
    { word: 'K8s', reading: '凯特斯', system: 'hanzi' },
  ]);
  eq('S8 清洗掉空词/空读音/非法体系', cleaned.length, 1);

  const without = removeCustomReading(both, { word: 'nguyen', system: 'hanzi' });
  eq('S8 删掉一条只影响这一条', without.length, 1);
  eq('S8 剩下的是片假名那条', without[0].system, 'katakana');

  // 真正接进提示计划：同一个词，有词表 / 无词表结果不同，来源也标出来。
  const text = 'Nguyen will send the report by 3 p.m. tomorrow.';
  const plain = buildHintPlan(text, 'English', 'hanzi');
  const nguyenPlain = plain.segments.find((seg) => seg.source === 'Nguyen');
  check('S8 没有词表时 Nguyen 可能标未确定或规则近似', Boolean(nguyenPlain), JSON.stringify(plain.segments));

  const withDict = buildHintPlan(text, 'English', 'hanzi', both);
  const nguyenCustom = withDict.segments.find((seg) => seg.source === 'Nguyen');
  eq('S8 词表命中后读法就是用户填的', nguyenCustom.hint, '努因');
  eq('S8 来源标成 manual', nguyenCustom.origin, 'manual');
  eq('S8 其它词仍是规则结果', withDict.segments.find((seg) => seg.source === 'report')?.origin, 'rule');

  const afterReset = buildHintPlan(text, 'English', 'hanzi', without);
  eq(
    'S8 删掉自定义后回到规则结果',
    afterReset.segments.find((seg) => seg.source === 'Nguyen')?.origin,
    'rule',
  );
}

// --------------------------------------------------------------------------- //
// S9. 短句：明天 / 下周必须分得清，关键词不许冒充译文
// --------------------------------------------------------------------------- //
{
  eq('S9a Tomorrow. 是明天', translateOffline('Tomorrow.', 'Chinese'), '明天。');
  eq('S9b Next week. 是下周', translateOffline('Next week.', 'Chinese'), '下周。');
  eq('S9c See you tomorrow. 是明天见', translateOffline('See you tomorrow.', 'Chinese'), '明天见。');
  eq('S9d See you next week. 是下周见', translateOffline('See you next week.', 'Chinese'), '下周见。');
  eq('S9e 不带句号也认', translateOffline('tomorrow', 'Chinese'), '明天。');
  eq('S9f 大写也认', translateOffline('NEXT WEEK.', 'Chinese'), '下周。');

  // 三句不能返回同一串
  const three = ['Tomorrow.', 'Next week.', 'See you tomorrow.'].map((text) =>
    translateOffline(text, 'Chinese'),
  );
  eq('S9g 三句译文互不相同', new Set(three).size, 3);

  // 目标语言不是中文时也要各自正确
  eq('S9h 日语方向 Tomorrow', translateOffline('Tomorrow.', 'Japanese'), '明日。');
  eq('S9i 日语方向 Next week', translateOffline('Next week.', 'Japanese'), '来週。');
  eq('S9j 英语方向 明天', translateOffline('明天。', 'English'), 'Tomorrow.');

  // 只认出关键词时必须有明确标识，且保留原话
  const hinted = translateOffline('Thanks a lot.', 'Chinese');
  eq('S9k 关键词兜底带说明', hinted.startsWith('〔演示模式只认出关键词'), true);
  eq('S9l 关键词兜底保留原话', hinted.includes('Thanks a lot.'), true);

  // 完全没收录：明说没有，不拿中文顶替
  const missing = translateOffline('Could you resend the invoice?', 'Japanese');
  eq('S9m 没有日语译文要明说', missing.includes('没有这句的日语译文'), true);
  eq('S9n 不拿中文当日语', /[\u4e00-\u9fff]/.test(missing.replace(/[〔〕a-zA-Z ]/g, '')), true);
}

// --------------------------------------------------------------------------- //
console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条`);
if (failures.length) {
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exit(1);
}
