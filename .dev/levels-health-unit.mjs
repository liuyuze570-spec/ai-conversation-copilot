/**
 * 分语言等级 / 一键体检 / 语气约束 —— 纯函数单测。
 *
 * import 的是 `dist/` 编译产物，也就是真正跑在用户机器上的那份代码。
 */
import {
  DEFAULT_LANGUAGE_LEVELS,
  LANGUAGE_LEVELS,
  defaultLevelFor,
  isKnownLevel,
  levelFor,
  levelsFor,
} from '../dist/shared/levels.js';
import { healthSummary, visibleIssues } from '../dist/shared/health.js';
import { levelGuidance, buildReplyMessages } from '../dist/services/llm/prompts.js';
import { expressionGuideFor } from '../dist/services/tone.js';

let pass = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) pass += 1;
  else failures.push(`${label}${detail ? ' — ' + detail : ''}`);
}
function eq(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function contains(label, haystack, needle) {
  check(label, String(haystack).includes(needle), `没有找到「${needle}」`);
}
function lacks(label, haystack, needle) {
  check(label, !String(haystack).includes(needle), `不该出现「${needle}」`);
}

// --------------------------------------------------------------------------- //
// 1. 每种对话语言一套等级
// --------------------------------------------------------------------------- //
{
  const en = levelsFor('English');
  const ja = levelsFor('Japanese');
  const ru = levelsFor('Russian');
  const ko = levelsFor('Korean');

  eq('英语 6 档', en.length, 6);
  eq('日语 5 档（N5→N1）', ja.length, 5);
  eq('俄语 5 档', ru.length, 5);
  eq('韩语 6 档（TOPIK 1→6）', ko.length, 6);

  contains('英语最浅是 B 级', en.map((o) => o.label).join('|'), '英语 B 级');
  contains('英语最深是专八', en.map((o) => o.label).join('|'), '专业八级');
  contains('日语有 N5', ja.map((o) => o.label).join('|'), 'N5');
  contains('日语有 N1', ja.map((o) => o.label).join('|'), 'N1');
  contains('俄语有专业八级', ru.map((o) => o.label).join('|'), '专业八级');
  contains('俄语有入门档（没有对应考试）', ru.map((o) => o.label).join('|'), '入门');
  contains('韩语最高 6 级', ko.map((o) => o.label).join('|'), '6 级');

  // 各语言不能互相串：日语里不该出现「四级」，英语里不该出现 N3。
  lacks('日语里没有英语四级', ja.map((o) => o.label).join('|'), '四级');
  lacks('英语里没有 JLPT', en.map((o) => o.label).join('|'), 'N3');

  eq('日语默认 N3', defaultLevelFor('Japanese'), 'ja-n3');
  eq('韩语默认 TOPIK 3', defaultLevelFor('Korean'), 'ko-t3');
  eq('未知语言回英语', defaultLevelFor('Klingon'), 'cet4');
  eq('未知语言用英语梯队', levelsFor('Klingon').length, 6);
}

// --------------------------------------------------------------------------- //
// 2. 取值容错：老设置 / 串语言 / 手工改坏
// --------------------------------------------------------------------------- //
{
  eq('没存过值时用该语言默认档', levelFor(undefined, 'Japanese'), 'ja-n3');
  eq('存了合法值就用它', levelFor({ English: 'cet6' }, 'English'), 'cet6');
  eq('非法值回默认', levelFor({ Japanese: 'bogus' }, 'Japanese'), 'ja-n3');
  eq('把英语值塞给日语 → 回日语默认', levelFor({ Japanese: 'cet4' }, 'Japanese'), 'ja-n3');
  // 关键：各语言互不影响 —— 切到日语的默认值不会覆盖英语的选择。
  const mixed = { English: 'tem8', Japanese: 'ja-n1' };
  eq('英语不受日语影响', levelFor(mixed, 'English'), 'tem8');
  eq('日语不受英语影响', levelFor(mixed, 'Japanese'), 'ja-n1');
  check('isKnownLevel 认得日语', isKnownLevel('Japanese', 'ja-n2'));
  check('isKnownLevel 不认串门值', !isKnownLevel('Japanese', 'cet4'));
  eq('默认值表覆盖四种语言', Object.keys(DEFAULT_LANGUAGE_LEVELS).sort(), ['English', 'Japanese', 'Korean', 'Russian']);
  eq('四种语言都有梯队', Object.keys(LANGUAGE_LEVELS).sort(), ['English', 'Japanese', 'Korean', 'Russian']);
}

// --------------------------------------------------------------------------- //
// 3. 提示词按语言的等级给规则
// --------------------------------------------------------------------------- //
{
  contains('英语四级描述', levelGuidance('English', 'cet4').name, 'Band 4');
  contains('日语 N1 描述', levelGuidance('Japanese', 'ja-n1').name, 'JLPT N1');
  contains('韩语 5 级描述', levelGuidance('Korean', 'ko-t5').name, 'TOPIK Level 5');
  contains('俄语专业四级描述', levelGuidance('Russian', 'ru-tr4').name, 'TEM-4');

  // 串门的等级值必须回「该语言」的默认档，而不是英语四级。
  contains('日语收到 cet4 → 回日语默认档', levelGuidance('Japanese', 'cet4').name, 'JLPT N3');
  contains('韩语收到空值 → 回韩语默认档', levelGuidance('Korean', undefined).name, 'TOPIK Level 3');

  const jaBasic = levelGuidance('Japanese', 'ja-n5').rule;
  const jaNative = levelGuidance('Japanese', 'ja-n1').rule;
  check('N5 与 N1 的用词规则必须不同', jaBasic !== jaNative, jaBasic);

  // 日语提示词首行必须说清是日语、什么水平（以前这里写死英语四级）。
  const messages = buildReplyMessages({
    context: 'Foreign: この番組、本当に面白いね。',
    level: 'ja-n3',
    style: 'natural',
    length: 'normal',
    mode: 'reply',
    tone: 'auto',
    language: 'Japanese',
    scenario: 'conversation',
  });
  const system = messages[0].content;
  contains('日语提示词写明日语', system, 'spoken-Japanese');
  contains('日语提示词写明 JLPT N3', system, 'JLPT N3');
  lacks('日语提示词不再出现英语等级', system, 'College English Test');
  contains('日语提示词要求假名/汉字', system, 'kana/kanji');
}

// --------------------------------------------------------------------------- //
// 4. 语气：指定了就照做，自动才看对方
// --------------------------------------------------------------------------- //
{
  const base = {
    context: 'Foreign: I got the job! I still cannot believe it.',
    level: 'cet4',
    style: 'natural',
    length: 'normal',
    mode: 'reply',
    language: 'English',
    scenario: 'conversation',
  };

  const happy = buildReplyMessages({ ...base, tone: 'happy' })[0].content;
  contains('指定开心 → 写明是固定情绪', happy, '固定为「开心」');
  contains('指定开心 → 是硬性要求', happy, 'hard requirement');
  contains('指定开心 → 不许被对话带偏', happy, 'Do NOT let what the other person said override this setting');
  contains('指定开心 → 三条都要同一个情绪', happy, 'All three cards share this mood');

  const auto = buildReplyMessages({ ...base, tone: 'auto' })[0].content;
  contains('自动 → 由模型判断', auto, 'MOOD — 自动');
  contains('自动 → 先看对方最后一句', auto, 'LAST line the other person said');
  contains('自动 → 对方开心就开心', auto, 'happy or excited → warm and upbeat');
  lacks('自动 → 不写死成某个情绪', auto, '固定为「');

  // 风格与语气冲突时的优先级必须写死。
  contains('说明风格管用词、语气管情绪', happy, 'STYLE sets the WORDING and politeness level');
  contains('冲突时按用户的设置来', happy, 'dry, polite remark');

  // 正式风格下不能出现网络俚语（模型看到就会照抄）。
  const formal = buildReplyMessages({ ...base, tone: 'auto', style: 'formal' })[0].content;
  lacks('正式风格不喂网络俚语', formal, "I'm dead");
  lacks('正式风格不喂亲密表达', formal, 'I really like spending time with you');
  contains('正式风格仍保留日常表达', formal, "How's it going?");

  // 指定语气时只给对口的表达组。
  contains('难过语气给难过表达', expressionGuideFor('sad', 'natural'), "That's rough");
  lacks('难过语气不给网络俚语', expressionGuideFor('sad', 'natural'), "I'm dead");
  lacks('生气语气不给亲密表达', expressionGuideFor('angry', 'natural'), 'I really like spending time with you');
  contains('生气语气给强情绪表达', expressionGuideFor('angry', 'natural'), 'so frustrating');
  contains('自动语气保留完整表达库', expressionGuideFor('auto', 'natural'), "I'm dead");
}

// --------------------------------------------------------------------------- //
// 5. 一键体检：只显示有问题的项
// --------------------------------------------------------------------------- //
{
  const clean = {
    checkedAt: 1,
    items: [
      { id: 'python', level: 'ok', title: '音频组件正常' },
      { id: 'signal', level: 'ok', title: '能听到声音' },
    ],
  };
  eq('全部正常 → 没有问题项', visibleIssues(clean.items).length, 0);
  const okSummary = healthSummary(clean);
  check('全部正常 → ok', okSummary.ok);
  contains('全部正常 → 只报一句结论', okSummary.headline, '没有发现问题');
  eq('全部正常 → 不显示副标题', okSummary.detail, '');

  const broken = {
    checkedAt: 1,
    items: [
      { id: 'python', level: 'ok', title: '音频组件正常' },
      { id: 'stt-key', level: 'fail', title: '没有可用的语音识别 Key' },
      { id: 'signal', level: 'warn', title: '没有听到声音' },
      { id: 'signal2', level: 'warn', title: '采样率偏低' },
    ],
  };
  eq('只留 warn / fail', visibleIssues(broken.items).map((i) => i.id), ['stt-key', 'signal', 'signal2']);
  const badSummary = healthSummary(broken);
  check('有 fail → 不算 ok', !badSummary.ok);
  eq('统计 fail 数量', badSummary.failed, 1);
  eq('统计 warn 数量', badSummary.warned, 2);
  contains('先说最要命的（失败数）', badSummary.headline, '发现 1 个问题');
  contains('同时报出建议条数，避免「1 个问题」下列了两条', badSummary.headline, '2 条建议');

  // 只有 warn 时不能吓人。
  const warnOnly = healthSummary({
    checkedAt: 1,
    items: [{ id: 'signal', level: 'warn', title: '没有听到声音' }],
  });
  check('只有建议时仍算可用', warnOnly.ok);
  contains('只有建议时措辞克制', warnOnly.headline, '能用');

  check('没检查过不谎报通过', healthSummary(null).headline !== '检查完成，没有发现问题');
}

// --------------------------------------------------------------------------- //
console.log('');
if (failures.length) {
  for (const failure of failures) console.log('  ✗ ' + failure);
  console.log(`\n${pass}/${pass + failures.length} 通过，${failures.length} 条失败`);
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} 全部通过`);
