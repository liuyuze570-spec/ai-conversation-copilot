/**
 * 0.7.0-web.10 回归（2026-11-09 用户现场反馈）。
 *
 * 两个真实问题：
 *  1. 「可以回的话全是固定的」—— 影视对白没有金额/日期事实，旧版永远落回
 *     三条写死的兜底句。这里锁住「回复随内容变」+ 有事实句子的确认句不倒退。
 *  2. 「影视只能一条一条，太慢」—— 新增整段轨，锁住分块不拆句、不静默丢句子。
 *
 * 另外验诚实边界：英文回复不夹中文、不替用户承诺、不暴露听力状况。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planReplies,
  detectScene,
  contentReplies,
  REPLY_SOURCE_NOTE,
} = require('../dist/shared/reply-plan.js');
const { extractFactsWithRules } = require('../dist/shared/facts.js');
const { chunkForTranslation, contextWindow } = require('../dist/shared/caption-pipeline.js');

const phon = (text) => text;
const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const FORBIDDEN = /I'll pay|I will pay|I'll be there|I'll attend|Yes, that works|I'm deaf|hard of hearing|我会付|我会准时|我听不见/i;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${name}${detail !== undefined ? `\n  got  ${JSON.stringify(detail)}` : ''}`);
  }
}

function cardsOf(original, translation = '（测试译文）', context = []) {
  const facts = extractFactsWithRules({ originalText: original, translatedText: translation });
  return planReplies({ original, translation, facts, sourceLanguage: 'en', context }, phon);
}

/* ---- 1. 场景识别 -------------------------------------------------------- */
{
  const cases = [
    ['Hi there, good to see you.', 'greeting'],
    ['Thank you so much for your help.', 'thanks'],
    ["I'm sorry about the delay.", 'apology'],
    ['See you tomorrow, take care.', 'farewell'],
    ["Let's meet at three.", 'invitation'],
    ['Where did you put the file?', 'question'],
    ["This definitely the biggest movie that I've ever done.", 'superlative'],
    ['I think we should wait a little.', 'opinion'],
    ['We went there yesterday and it started raining.', 'story'],
    ['The report is on the desk.', 'statement'],
  ];
  for (const [text, expected] of cases) {
    ok(`场景 ${expected}: ${text.slice(0, 32)}`, detectScene(text) === expected, detectScene(text));
  }
  ok('短句借上一句判场景', detectScene('Yeah.', ["This definitely the biggest movie that I've ever done."]) === 'superlative');
  ok('短句没有上下文时落 statement', detectScene('Yeah.') === 'statement', detectScene('Yeah.'));
  ok('上下文里就是当前句时不把自己当背景', detectScene('Yeah.', ['Yeah.']) === 'statement');
}

/* ---- 2. 回复随内容变，不再固定三句 -------------------------------------- */
{
  const movie = cardsOf("This definitely the biggest movie that I've ever done.", '这绝对是我拍过最大的电影');
  const thanks = cardsOf('Thank you so much for your help.', '太感谢你的帮忙了');
  const question = cardsOf('Where did you put the file?', '你把文件放哪儿了？');
  const oldThree = [
    'Sorry, could you say that again a little slower?',
    "Thank you, I've got it.",
    'Sorry, could you type that instead? It is easier for me.',
  ];

  ok('影视句给满三张', movie.length === 3, movie.length);
  ok('影视句不再等于旧的三句固定回复',
    movie.map((c) => c.en).join('|') !== oldThree.join('|'), movie.map((c) => c.en));
  ok('影视句第一张贴合最高级',
    /impressive|biggest/i.test(movie[0].en), movie[0].en);
  ok('影视句前两张都不是旧兜底句',
    !oldThree.slice(0, 2).includes(movie[0].en) && !oldThree.slice(0, 2).includes(movie[1].en),
    movie.slice(0, 2).map((c) => c.en));
  ok('影视句第三张仍是「请求重复/打字」类澄清',
    /say that again a little slower|type that instead/i.test(movie[2].en), movie[2].en);
  ok('影视句与道谢句的三张回复不同',
    movie.map((c) => c.en).join('|') !== thanks.map((c) => c.en).join('|'));
  ok('影视句与提问句的三张回复不同',
    movie.map((c) => c.en).join('|') !== question.map((c) => c.en).join('|'));
  ok('道谢句给出「不客气」', /welcome|No problem/i.test(thanks[0].en), thanks[0].en);
  ok('提问句不硬答、只承诺回复', /get back to you/i.test(question[0].en), question[0].en);

  for (const group of [movie, thanks, question]) {
    for (const card of group) {
      ok(`英文回复不夹中文：${card.id}`, !CJK.test(card.en), card.en);
      ok(`不替用户承诺 / 不暴露听障：${card.id}`, !FORBIDDEN.test(card.en), card.en);
      ok(`有中文意思：${card.id}`, card.zh.trim().length > 0, card.zh);
      ok(`有近音分段：${card.id}`, card.segments.length > 0 && card.segments[0].phon.length > 0, card.segments);
      ok(`有用途与理由：${card.id}`, card.purpose.length > 0 && card.why.length > 0);
    }
  }
  ok('来源标注不冒充 AI', !/AI|模型生成/.test(REPLY_SOURCE_NOTE.rule), REPLY_SOURCE_NOTE.rule);
  ok('contentReplies 三张 id 带场景', contentReplies('superlative').every((c) => c.id.startsWith('content-superlative-')));
}

/* ---- 3. 上下文进入回复卡 ------------------------------------------------ */
{
  const context = [
    'We filmed it in three months.',
    "This definitely the biggest movie that I've ever done.",
  ];
  const cards = cardsOf('Yeah.', '是的。', context);
  ok('短句也按前文场景给回复', /impressive|biggest/i.test(cards[0].en), cards[0].en);
  ok('理由里写明结合了前文', /结合前面 2 句/.test(cards[0].why), cards[0].why);
  const noContext = cardsOf('Yeah.', '是的。');
  ok('没有上下文时不假称结合了前文', !/结合前面/.test(noContext[0].why), noContext[0].why);
}

/* ---- 4. 有事实的核心回归没有被新分支吃掉 -------------------------------- */
{
  const money = cardsOf('The deposit is 300 and the remaining balance is 900.', '定金300，余款900。');
  ok('金额句仍是 confirm-money', money[0].id === 'confirm-money', money.map((c) => c.id));
  ok('金额句仍问币种', /What currency/.test(money[0].en), money[0].en);
  ok('金额句不进内容场景分支', !money.some((c) => c.id.startsWith('content-')), money.map((c) => c.id));

  const moved = cardsOf(
    'The rehearsal has moved from Wednesday morning to Friday afternoon. It will still last ninety minutes.',
    '排练由周三上午改到周五下午，仍持续90分钟。',
  );
  ok('改期句仍是 confirm-reschedule', moved[0].id === 'confirm-reschedule', moved.map((c) => c.id));
  ok('改期句仍写 instead of', /instead of/.test(moved[0].en), moved[0].en);

  const negated = cardsOf('The appointment is at 4:20 p.m. on Wednesday, not Thursday.', '约在周三下午4:20，不是周四。');
  ok('否定句不进内容场景分支', !negated.some((c) => c.id.startsWith('content-')), negated.map((c) => c.id));
  ok('否定句仍保留澄清分支', negated.some((c) => c.id === 'clarify-negation' || c.id.startsWith('confirm-')), negated.map((c) => c.id));
}

/* ---- 5. 整段分块：不拆句、不静默丢 -------------------------------------- */
{
  ok('空输入没有块', chunkForTranslation([]).chunks.length === 0);
  const three = chunkForTranslation(['First one.', 'Second one.', 'Third one.'], 500, 4);
  ok('三短句合成一块', three.chunks.length === 1, three.chunks);
  ok('一块里包含全部句子', three.chunks[0].text.includes('First one.') && three.chunks[0].text.includes('Third one.'));
  ok('覆盖区间正确', three.chunks[0].from === 0 && three.chunks[0].to === 3, three.chunks[0]);
  ok('没有句子被略过', three.omitted === 0);

  const long = Array.from({ length: 10 }, (_unused, i) => `Sentence number ${i + 1} is ${'word '.repeat(18).trim()}.`);
  const split = chunkForTranslation(long, 120, 20);
  ok('超长内容按句分成多块', split.chunks.length > 1, split.chunks.length);
  ok('每块都不被从句子中间切断',
    split.chunks.every((c) => c.text.trim().endsWith('.')), split.chunks.map((c) => c.text.slice(-40)));
  ok('覆盖区间连起来不漏句',
    split.chunks[0].from === 0 && split.chunks.at(-1).to === long.length,
    [split.chunks[0].from, split.chunks.at(-1).to]);

  const capped = chunkForTranslation(long, 120, 2);
  ok('超过块数上限时如实报 omitted', capped.omitted > 0, capped.omitted);
  ok('超过上限只保留最近的内容',
    capped.chunks.at(-1).text.includes('Sentence number 10') && !capped.chunks[0].text.includes('Sentence number 1'),
    capped.chunks.map((c) => c.text.slice(0, 30)));
  ok('covered + omitted 等于总句数',
    capped.chunks.reduce((sum, c) => sum + c.to - c.from, 0) + capped.omitted === long.length);

  const huge = chunkForTranslation(['X'.repeat(400)], 120, 4);
  ok('单句超长单独成块且不截断', huge.chunks.length === 1 && huge.chunks[0].text.length === 400, huge.chunks[0]?.text.length);
  ok('单句超长标记 oversized', huge.oversized === 1, huge.oversized);
}

/* ---- 6. 上下文窗口 ------------------------------------------------------ */
{
  const sentences = Array.from({ length: 12 }, (_unused, i) => `line-${i + 1}`);
  const window = contextWindow(sentences, 6, 600);
  ok('只取最近 6 句', window.length === 6, window);
  ok('保留原始顺序', window[0] === 'line-7' && window.at(-1) === 'line-12', window);
  const limited = contextWindow(Array.from({ length: 8 }, () => 'y'.repeat(200)), 6, 600);
  ok('总长受限时少取几句', limited.length < 6 && limited.length >= 1, limited.length);
  ok('空上下文返回空', contextWindow([]).length === 0);
}

console.log(`\n[P3 content/passage] ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
