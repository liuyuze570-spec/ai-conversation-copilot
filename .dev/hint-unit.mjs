/**
 * 读音辅助（0.6.0 核心）的回归测试。
 *
 * 这一组用例的来源很明确：0.5.0 的 53 条发音测试全绿，用户装上软件第一次
 * 试日语就撞上「カメラ → kara」「コーヒー → kohi」「空港 → 空港」。原因是旧
 * 断言只覆盖了平假名词表，片假名、长音、促音、拗音、未知汉字一个都没测。
 *
 * 所以这里不再写「看起来对」的断言，而是逐条钉死：
 *   A. 平假名 / 片假名必须给出同一个读法（同一句话两种写法）
 *   B. 长音、促音、拗音不许吞音或拆散
 *   C. 词典里没有的汉字要标「未确定」，不许把汉字当读音、不许静默编一个
 *   D. 提示必须与原文逐词对齐（片段带原文范围），原文一改旧提示就失效
 *   E. 无关读音不能冒充（「こんにちは」配 banana 必须被拒）
 *   F. 同一句英语换提示体系，结果不串（汉字近音 / 片假名）
 *   G. 纯数字不当作「读不出来」
 *   H. 中文近音里不许出现标点（用户会以为那是要念出来的东西）
 *
 * 运行：node .dev/hint-unit.mjs
 */
import {
  buildHintPlan,
  hintLooksWrong,
  readJapanese,
} from '../dist/services/pronunciation.js';

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

function truthy(label, value, detail = '') {
  check(label, Boolean(value), detail || `实际 ${JSON.stringify(value)}`);
}

// --------------------------------------------------------------------------- //
// A. 平假名 / 片假名等价
// --------------------------------------------------------------------------- //
{
  const pairs = [
    ['カメラ', 'かめら', 'kamera'],
    ['カタカナ', 'かたかな', 'katakana'],
    ['ガッコウ', 'がっこう', 'gakkou'],
    ['コーヒー', 'こーひー', 'koohii'],
    ['ホテル', 'ほてる', 'hoteru'],
  ];
  for (const [kata, hira, expected] of pairs) {
    const a = readJapanese(kata);
    const b = readJapanese(hira);
    eq(`A 片假名 ${kata} 读作 ${expected}`, a.roman, expected);
    eq(`A 平假名 ${hira} 读作 ${expected}`, b.roman, expected);
    eq(`A ${kata} 与 ${hira} 读法一致`, a.roman, b.roman);
    eq(`A ${kata} 没有未确定项`, a.unknown.length, 0);
  }
}

// --------------------------------------------------------------------------- //
// B. 长音 / 促音 / 拗音
// --------------------------------------------------------------------------- //
{
  // 长音必须复写元音，不能只留一个（旧的 kohi 就是丢了长音）。
  eq('B 长音 コーヒー → koohii', readJapanese('コーヒー').roman, 'koohii');
  eq('B 长音 コーラ → koora', readJapanese('コーラ').roman, 'koora');
  eq('B 促音 がっこう → gakkou', readJapanese('がっこう').roman, 'gakkou');
  eq('B 促音 まっすぐ → massugu', readJapanese('まっすぐ').roman, 'massugu');
  // 拗音不能被拆成两个音节（旧的 kiu / shishin 就是把 きょ 拆开了）。
  eq('B 拗音 きょう → kyou', readJapanese('きょう').roman, 'kyou');
  eq('B 拗音 しゃしん → shashin', readJapanese('しゃしん').roman, 'shashin');
  eq('B 拗音 ちょっと → chotto', readJapanese('ちょっと').roman, 'chotto');
  // 片假名外来音的拗音也要认（ティ / ファ 这类）。
  eq('B 外来音 パーティー → paatii', readJapanese('パーティー').roman, 'paatii');
}

// --------------------------------------------------------------------------- //
// C. 未知汉字：宁可空着，不许编
// --------------------------------------------------------------------------- //
{
  const rare = readJapanese('鰤と鬱');
  truthy('C 生僻汉字被记为未确定', rare.unknown.includes('鰤') && rare.unknown.includes('鬱'),
    JSON.stringify(rare.unknown));
  // 汉字不许出现在罗马字里冒充读音（「空港 → 空港」那个错就是这一条的反面）。
  check('C 罗马字里没有汉字', !/[\u4e00-\u9fff]/.test(rare.roman), rare.roman);

  const known = readJapanese('空港');
  eq('C 词典里的汉字有读音', known.roman, 'kuukou');
  eq('C 词典命中的汉字不算未确定', known.unknown.length, 0);

  // 未确定的词在 buildHintPlan 里必须整词丢掉提示，而不是留一半。
  const plan = buildHintPlan('鰤と鬱', 'Japanese', 'romaji');
  eq('C 含未确定汉字的句子标 partial', plan.status, 'partial');
  const bad = plan.segments.find((s) => s.source === '鰤');
  eq('C 未确定片段的 hint 为空（不编）', bad?.hint, '');
  eq('C 未确定片段的 status', bad?.status, 'unknown');
}

// --------------------------------------------------------------------------- //
// D. 提示与原文逐词对齐
// --------------------------------------------------------------------------- //
{
  const plan = buildHintPlan('Please send the report.', 'English', 'hanzi');
  eq('D 片段数＝词数', plan.segments.length, 4);
  eq('D 片段 id 用原文范围', plan.segments[0].id, '0-6');
  eq('D 片段 source 就是原文那一段', plan.segments[0].source, 'Please');
  check(
    'D 每个片段都能在原文里找到自己',
    plan.segments.every((s) => 'Please send the report.'.slice(s.from, s.to) === s.source),
  );

  // 原文改了 → 旧片段的 id 不该还能对上（这是「提示失效」的机制）。
  const changed = buildHintPlan('Please send the file.', 'English', 'hanzi');
  const oldIds = new Set(plan.segments.map((s) => s.id));
  const stillSame = changed.segments.filter(
    (s) => oldIds.has(s.id) && 'Please send the report.'.slice(s.from, s.to) !== s.source,
  );
  eq('D 原文改写后没有错位的片段', stillSame.length, 0);

  // 版本号必须进计划，历史记录与缓存键都靠它。
  eq('D 计划带算法版本', plan.version, 2);
  eq('D 不支持的组合返回 unsupported', buildHintPlan('Hello', 'English', 'none').status, 'unsupported');
  eq('D 不支持的组合不给文本', buildHintPlan('Hello', 'English', 'none').text, '');
}

// --------------------------------------------------------------------------- //
// E. 无关读音不能冒充
// --------------------------------------------------------------------------- //
{
  eq('E banana 配 こんにちは 被拒', hintLooksWrong('banana', 'こんにちは', 'Japanese', 'romaji'), true);
  eq('E konnichiwa 配 こんにちは 通过', hintLooksWrong('konnichiwa', 'こんにちは', 'Japanese', 'romaji'), false);
  eq('E 片假名体系给平假名被拒', hintLooksWrong('こんにちは', 'こんにちは', 'Japanese', 'katakana'), true);
  eq('E 片假名体系给片假名通过', hintLooksWrong('コンニチワ', 'こんにちは', 'Japanese', 'katakana'), false);
  eq('E 罗马字体系给片假名被拒', hintLooksWrong('ハロー', 'こんにちは', 'Japanese', 'romaji'), true);
  eq('E 空提示直接判失败', hintLooksWrong('', 'こんにちは', 'Japanese', 'romaji'), true);
  eq('E 英语汉字近音体系给拉丁字母被拒', hintLooksWrong('please', 'Please send', 'English', 'hanzi'), true);
}

// --------------------------------------------------------------------------- //
// F. 换体系不串
// --------------------------------------------------------------------------- //
{
  const source = 'Please send the report by 3 p.m. tomorrow.';
  const hanzi = buildHintPlan(source, 'English', 'hanzi');
  const kata = buildHintPlan(source, 'English', 'katakana');

  eq('F 汉字体系的 system 字段', hanzi.system, 'hanzi');
  eq('F 片假名体系的 system 字段', kata.system, 'katakana');
  check('F 两种体系的整行文本不同', hanzi.text !== kata.text, `${hanzi.text} / ${kata.text}`);
  check('F 汉字体系里有汉字', /[\u4e00-\u9fff]/.test(hanzi.text), hanzi.text);
  check('F 片假名体系里没有汉字', !/[\u4e00-\u9fff]/.test(kata.text), kata.text);
  check('F 片假名体系用的是片假名', /[\u30a0-\u30ff]/.test(kata.text), kata.text);
  eq('F 两种体系的片段 id 相同（结构一致）',
    hanzi.segments.map((s) => s.id).join(','),
    kata.segments.map((s) => s.id).join(','));

  // 日语目标 + 罗马字：要能断词，不能一整串
  const ja = buildHintPlan('もう一度お願いします。', 'Japanese', 'romaji');
  eq('ja 日语罗马字提示', ja.text, 'mouichido onegai shi masu');
  check('ja 罗马字里有空格（能断词）', ja.text.includes(' '), ja.text);

  // 日语目标 + 片假名：给的是片假名，不是罗马字
  const jaKata = buildHintPlan('コーヒーをください', 'Japanese', 'katakana');
  check('ja 片假名提示里没有拉丁字母', !/[a-z]/.test(jaKata.text), jaKata.text);
}

// --------------------------------------------------------------------------- //
// G. 数字不当作读不出来
// --------------------------------------------------------------------------- //
{
  const plan = buildHintPlan('Please send the report by 3 p.m. tomorrow.', 'English', 'hanzi');
  // 这条断言原本钉的是 status === 'ok'。0.6.1 加了「规则近似」状态之后，
  // 一句话只要有一个词典没收录的词就会是 approx —— 这里真正要保证的是
  // 「数字不把整句拖成 partial」，所以改成钉这一点，另外单独钉数字自身状态。
  check(
    'G 句子里有数字也不该是 partial',
    plan.status !== 'partial' && plan.unknown.length === 0,
    `status=${plan.status} unknown=${JSON.stringify(plan.unknown)}`,
  );
  const three = plan.segments.find((s) => s.source === '3');
  // 0.6.3 修复：数字不再「原样保留」，而是给出英语读音 —— 450/540 这种金额
  // 用户需要照着念出来，裸数字等于没有近音辅助。3 的读法是「斯瑞」(three)。
  eq('G 数字给英语读音（不再裸数字）', three?.hint, '斯瑞');
  eq('G 数字读音标近似（规则拼读）', three?.status, 'approx');
}


// --------------------------------------------------------------------------- //
// I. 缩写按字母名念，不逐字母硬拼成假单词
// --------------------------------------------------------------------------- //
{
  const pdf = buildHintPlan('I will email the PDF today.', 'English', 'hanzi');
  const seg = pdf.segments.find((s) => s.source === 'PDF');
  eq('I PDF 按字母名念', seg?.hint, '匹 迪 艾夫');
  eq('I PDF 标规则近似（不冒充已核对）', seg?.status, 'approx');

  // 0.6.0 的真实错读：p.m. → 普姆（把 p 和 m 当音节拼）
  const pm = buildHintPlan('The call is at 3 p.m. today.', 'English', 'hanzi');
  eq('I 3 p.m. 不再读成「普姆」', pm.segments.find((s) => s.source.startsWith('p.m'))?.hint, '皮艾姆');

  // 称谓：Mr. 被分词器切成 Mr（点丢了）也要按整词念
  const mr = buildHintPlan('Mr. Tanaka will call.', 'English', 'hanzi');
  eq('I Mr 读米斯特，不读姆尔', mr.segments.find((s) => s.source === 'Mr')?.hint, '米斯特');

  // 词典没收录的人名必须标近似，不能和词典命中一个样子
  const name = buildHintPlan('Okafor is here.', 'English', 'hanzi');
  eq('I 词典外姓名标近似', name.segments.find((s) => s.source === 'Okafor')?.status, 'approx');
  eq('I 词典命中的词标 ok', name.segments.find((s) => s.source === 'is')?.status, 'ok');
  check('I 有近似时整句状态为 approx', name.status === 'approx', name.status);

  /*
   * 单个字母必须是字母名，不能走音节拼读。
   *
   * 这条是被打包版自检打出来的：Chromium 的 ICU 把 `p.m.` 切成 `p` + `m`
   * 两段（Node 切成一段），于是界面上显示「普 姆」。Node 这边复现不了那个切法，
   * 所以这里直接钉「单个字母」这一层的读法。
   */
  const oneLetter = buildHintPlan('Plan p is ready.', 'English', 'hanzi');
  eq('I 单个字母按字母名念', oneLetter.segments.find((s) => s.source === 'p')?.hint, '匹');
}

// --------------------------------------------------------------------------- //
// J. 会议/日程高频词走词表，不靠字母拼
// --------------------------------------------------------------------------- //
{
  const plan = buildHintPlan('The meeting moved to Thursday.', 'English', 'hanzi');
  eq('J meeting 查表', plan.segments.find((s) => s.source === 'meeting')?.hint, '米廷');
  eq('J Thursday 查表', plan.segments.find((s) => s.source === 'Thursday')?.hint, '瑟兹德伊');
  check('J 这句全部来自词表', plan.status === 'ok', `${plan.status} approx=${plan.approximate}`);
}

// --------------------------------------------------------------------------- //
// H. 中文近音里不许有标点
// --------------------------------------------------------------------------- //
{
  eq('H 促音不塞「·」', readJapanese('がっこう').zh, '嘎科乌');
  eq('H 长音不塞「ー」', readJapanese('コーヒー').zh, '科希');
  eq('H 习惯读法 こんにちは → konnichiwa', readJapanese('こんにちは').roman, 'konnichiwa');
  eq('H 助词 は 读 wa', readJapanese('会議は').roman, 'kaigiha'.replace('ha', 'wa'));
  const zh = readJapanese('コーヒーをください').zh;
  check('H 近音里没有标点', !/[·ー、。，！？]/.test(zh), zh);
}

// --------------------------------------------------------------------------- //
console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条`);
if (failures.length) {
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exit(1);
}
