/**
 * 注音字段（ipa / syllables）可信度校验的单元验证。
 *
 * 断言里的脏数据全部来自 `.dev/llm-probe.js` 对真实接口的四组真实请求
 * （Qwen2.5-7B-Instruct，2026-10-04）—— 不是编出来的例子，是被真机复现过的
 * 回归样例。import 的是 dist/ 编译产物，也就是用户机器上真正跑的那份代码。
 *
 * 运行：node .dev/pron-unit.mjs
 */
import { enrichDrafts, ipaLooksWrong, syllablesLookWrong, tidyChinese } from '../dist/services/pronunciation.js';

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

function falsy(label, value, detail = '') {
  check(label, !value, detail || `实际 ${JSON.stringify(value)}`);
}

// --------------------------------------------------------------------------- //
// 1. ipa：真实脏数据必须被丢掉
// --------------------------------------------------------------------------- //
{
  // 看视频场景：模型把 ipa 写成了中文拼音（带声调）。
  truthy(
    '中文拼音（带声调）判为不可信',
    ipaLooksWrong('zhēn yīnáng xiǎn zhe tóng yīng tóng yígē láng qún dài sì ge dōng tiān', 'I can\'t imagine staying with the same wolves for four winters.'),
  );
  truthy(
    '中文拼音（无空格、带 ǎ）判为不可信',
    ipaLooksWrong('nɑ ɛr ɦǎo ah ， ni zui jin zěn moh yɑŋ ？', 'That\'s cool, what\'s new with you?'),
  );
  truthy(
    '中文拼音（纯拉丁字母 + ō）判为不可信',
    ipaLooksWrong('wa za na da da huo da chuo pōng', "Wow, that's a long commitment."),
  );
  // 抄原文。
  truthy('抄了英文原文判为不可信', ipaLooksWrong('i am good how about you', 'I am good, how about you?'));
  truthy(
    '抄原文（标点不同）判为不可信',
    ipaLooksWrong("I'm really impressed with your progress want to share more", "I'm really impressed with your progress. Want to share more?"),
  );
  // 太短。
  truthy('短得不合常理判为不可信', ipaLooksWrong('ju', 'I really like spending time with you'));
  // 一个 IPA 专属字符都没有。
  truthy('纯拼写式判为不可信', ipaLooksWrong('wow thats a long commitment', "Wow, that's a long commitment."));
  // 混进了别的文字（第二次真实运行抓到的）：天城文 / 希腊字母。
  truthy(
    '音标里混天城文判为不可信',
    ipaLooksWrong('ðæt ɪz ə ˈlɔːŋ kəmˈmɪtमnt', "That's a long commitment."),
  );
  truthy(
    '音标里混希腊字母判为不可信',
    ipaLooksWrong('aɪ ˈkɑːn ˈɑːmɪdʒi ðə ˈkeɪmɪνteɪ ʧælɪˈɛntz ðeɪ ˈfeɪst', 'I can only imagine the challenges they faced.'),
  );
  truthy(
    '音标里混汉字判为不可信',
    ipaLooksWrong('kuː 中文 mə', 'Cool, me too!'),
  );
}

// --------------------------------------------------------------------------- //
// 2. ipa：真实正确数据必须保留
// --------------------------------------------------------------------------- //
{
  falsy(
    '正常宽式音标保留',
    ipaLooksWrong('aɪ kæn nɔɪ ɪmɪdʒɪn steɪɪŋ wɪð ðəm ðæt lɔːŋ', "I can't imagine staying with them that long."),
  );
  falsy('短句音标保留', ipaLooksWrong('kuː mə tuː', 'Cool, me too!'));
  falsy(
    '带重音符的短句音标保留',
    ipaLooksWrong('ðæt zɪz ə lɔːŋ kəmɪtənt', "That's a long commitment."),
  );
  // 空值是合法的 —— 提示词本来就允许「不确定就留空」。
  falsy('空字符串不算错', ipaLooksWrong('', 'Hello there'));
  falsy('undefined 不算错', ipaLooksWrong(undefined, 'Hello there'));
}

// --------------------------------------------------------------------------- //
// 3. syllables：真实脏数据必须被丢掉
// --------------------------------------------------------------------------- //
{
  truthy(
    '中文分块判为不可信',
    syllablesLookWrong(['真 难 以 想 象', '同 一 个', '狼 群', '待 四 个', '冬 天'], 'I can\'t imagine staying with the same wolves for four winters.'),
  );
  truthy(
    '混进音标的分块判为不可信',
    syllablesLookWrong(['I ˈtəʊtəl əˈɡri:', 'i ˈti:θvɪz ˈfaɪvɪt', 'ðɪs ˈwɪkɪθɪŋ'], "I totally agree, it's been my favorite this week."),
  );
  truthy(
    '整句重复一遍的分块判为不可信',
    syllablesLookWrong(
      ['Have', 'you', 'found', 'any', 'interesting', 'parts', 'have', 'you', 'found', 'any', 'interesting', 'parts', 'I', 'loved', 'their', 'winter', 'scenes'],
      'Have you found any interesting parts? I loved their winter scenes.',
    ),
  );
  truthy('丢词的分块判为不可信', syllablesLookWrong(['Have', 'you'], 'Have you found any interesting parts?'));
  truthy(
    '纯标点块判为不可信',
    syllablesLookWrong(['That\'s', 'great', '? I\'m', 'so', 'glad', 'you', 'enjoy', 'it', '.', 'Do', 'you', 'have', 'a', 'favorite', 'part', '?'], "That's great, I'm so glad you enjoy it. Do you have a favorite part?"),
  );
  truthy(
    '以标点开头的块判为不可信',
    syllablesLookWrong(['Rea-lly', '? Me too', "it's my", 'fa-vor-ite', 'show'], "Really? Me too, it's my favorite show."),
  );
}

// --------------------------------------------------------------------------- //
// 4. syllables：真实正确数据必须保留
// --------------------------------------------------------------------------- //
{
  falsy(
    '正常分块保留',
    syllablesLookWrong(['I', "can't", 'imagine', 'staying', 'with', 'them', 'that', 'long'], "I can't imagine staying with them that long."),
  );
  falsy('带问号的分块保留', syllablesLookWrong(['Cool', 'me too'], 'Cool, me too!'));
  falsy(
    '分块里带连字符也保留（拼不回是标点差异）',
    syllablesLookWrong(['Rea-lly', 'what made you', 'say that'], 'Really, what made you say that?'),
  );
  falsy('空分块不算错（交给本地引擎）', syllablesLookWrong([], 'Hello there'));
}

// --------------------------------------------------------------------------- //
// 5. enrichDrafts：整条链路 —— 脏字段被替换，干净字段被保留
// --------------------------------------------------------------------------- //
{
  const [draft] = enrichDrafts(
    [
      {
        kind: 'natural',
        english: "I can't imagine staying with the same wolves for four winters.",
        chinese: '真难以想象同一个狼群待四个冬天。',
        ipa: 'zhēn yīnáng xiǎn zhe tóng yīng tóng yígē láng qún dài sì ge dōng tiān',
        syllables: ['真 难 以 想 象', '同 一 个', '狼 群'],
      },
    ],
    'English',
  );
  eq('脏 ipa 被丢掉', draft.ipa, undefined);
  truthy('脏分块被本地引擎替换', draft.syllables.every((chunk) => /^[A-Za-z'’\-]+$/.test(chunk)), JSON.stringify(draft.syllables));
  eq('分块数量 = 词数', draft.syllables.length, 11);
  eq('中文翻译原样保留', draft.chinese, '真难以想象同一个狼群待四个冬天。');

  const [clean] = enrichDrafts(
    [
      {
        kind: 'simple',
        english: 'Cool, me too!',
        chinese: '酷，我也是！',
        ipa: 'kuː mə tuː',
        syllables: ['Cool', 'me too'],
        chinesePronunciation: '库尔 梅 托欧',
      },
    ],
    'English',
  );
  eq('干净 ipa 保留', clean.ipa, 'kuː mə tuː');
  eq('干净分块保留', JSON.stringify(clean.syllables), JSON.stringify(['Cool', 'me too']));
  eq('干净中文谐音保留', clean.chinesePronunciation, '库尔 梅 托欧');

  // 模型干脆没给 syllables 时，必须由本地引擎补上 —— 曾经写成「空数组就原样
  // 透传 undefined」，结果卡片的分块那一行整行消失（第二次真实运行实测）。
  const [noChunks] = enrichDrafts(
    [{ kind: 'simple', english: 'That is a long commitment.', chinese: '那是一个长期的承诺。', ipa: 'ðæt ɪz ə ˈlɔːŋ kəmɪtmənt' }],
    'English',
  );
  eq('缺分块时本地补 5 块', noChunks.syllables.length, 5);
  truthy('本地补的分块全是英文', noChunks.syllables.every((c) => /^[A-Za-z'’\-]+$/.test(c)), JSON.stringify(noChunks.syllables));

  // 脏 JSON 里出现过裸 {}（真实运行两次）。英文缺失时不能整条崩掉。
  const [blank] = enrichDrafts([{ kind: 'simple', english: '', chinese: '空' }], 'English');
  eq('英文缺失时安全返回空分块', JSON.stringify(blank.syllables), '[]');
}

// --------------------------------------------------------------------------- //
// 5b. chinesePronunciation：模型把「中文的注音」塞进谐音栏（真实数据）
// --------------------------------------------------------------------------- //
{
  const english = "That's great! I'm right there with you.";
  const [draft] = enrichDrafts(
    [
      {
        kind: 'simple',
        english,
        chinese: '太棒了 我也是',
        // 实测原文：模型给的是**中文句子**的注音，不是英文的谐音。
        chinesePronunciation: '太 ɡe 棒 了 我 ɑm 也 是 在  dere 有 你 也',
      },
    ],
    'English',
  );
  truthy(
    '中文注音式的谐音被换成真谐音',
    !/[A-Za-z]{2,}|[əɪʊæɑɔʌʃʒθðŋɹɜɒɛɡˈˌː]/.test(draft.chinesePronunciation),
    draft.chinesePronunciation,
  );
  truthy('换出来的谐音全是汉字', /^[\u4e00-\u9fff\s]+$/.test(draft.chinesePronunciation), draft.chinesePronunciation);

  const [pure] = enrichDrafts(
    [{ kind: 'simple', english, chinese: '太棒了 我也是', chinesePronunciation: 'tài bāng le wǒ yě shì' }],
    'English',
  );
  truthy('纯拼音的谐音被换掉', /[\u4e00-\u9fff]/.test(pure.chinesePronunciation), pure.chinesePronunciation);
  truthy('纯拼音不会留下拉丁字母', !/[A-Za-z]/.test(pure.chinesePronunciation), pure.chinesePronunciation);

  const [good] = enrichDrafts(
    [{ kind: 'simple', english, chinese: '太棒了 我也是', chinesePronunciation: '撒茨 格瑞特 伊姆 赖特 泽尔 威兹 优' }],
    'English',
  );
  eq('正常谐音原样保留', good.chinesePronunciation, '撒茨 格瑞特 伊姆 赖特 泽尔 威兹 优');

  // 四六级场景实测：模型把整句中文（连带标点）抄进了谐音栏，而它和译文只差一个字，
  // 「等于译文」那条判据抓不住 —— 靠「谐音不该有标点」抓。
  const [exam] = enrichDrafts(
    [
      {
        kind: 'simple',
        english: "I'm talking about how great this show is, I watch it every week.",
        chinese: '我想说的这部剧真的太好看了，我每周都在追。',
        chinesePronunciation: '想说 的 这部 剧 真的 太 好看 了，我 每周 都 在 追。',
      },
    ],
    'English',
  );
  truthy('带标点的中文抄写被换掉', !/[，。！？]/.test(exam.chinesePronunciation), exam.chinesePronunciation);
  truthy('换出来的是真谐音', /[\u4e00-\u9fff]/.test(exam.chinesePronunciation), exam.chinesePronunciation);
}

// --------------------------------------------------------------------------- //
// 5c. romanization：英语没有罗马音，模型塞进来的一律丢掉（真实数据）
// --------------------------------------------------------------------------- //
{
  const [draft] = enrichDrafts(
    [
      {
        kind: 'simple',
        english: "That's great! I'm right there with you.",
        chinese: '太棒了 我也是',
        // 实测：英语模式下模型也给了这个字段，值是中文拼音。
        romanization: 'tài bàng le wǒ yě shì zài dāi yǒu nǐ yě',
      },
    ],
    'English',
  );
  eq('英语时罗马音被丢掉', draft.romanization, undefined);

  const [ru] = enrichDrafts(
    [{ kind: 'simple', english: 'Привет!', chinese: '你好！' }],
    'Russian',
  );
  truthy('非英语语言仍然生成罗马音', Boolean(ru.romanization), JSON.stringify(ru.romanization));
}

// --------------------------------------------------------------------------- //
// 6. chinese：逐字空格必须被清掉（真实运行里三条译文全中）
// --------------------------------------------------------------------------- //
{
  eq(
    '逐字空格被清掉',
    tidyChinese('真 的 呢 ， 同 样 我 也 爱 看 这 个 节 目'),
    '真的呢，同样我也爱看这个节目',
  );
  eq('英文单词之间的空格保留', tidyChinese('发个 email 给我'), '发个 email 给我');
  eq('单个汉字不动', tidyChinese('好'), '好');
  eq('空串安全', tidyChinese(''), '');
  eq('正常中文不动', tidyChinese('我挺好的，你呢？'), '我挺好的，你呢？');

  const [draft] = enrichDrafts(
    [{ kind: 'simple', english: 'Cool, me too!', chinese: '酷 ， 我 也 是 ！' }],
    'English',
  );
  eq('整条链路上的译文被清理', draft.chinese, '酷，我也是！');
}

// --------------------------------------------------------------------------- //
// 7. 非英语目标语言不能被误伤
// --------------------------------------------------------------------------- //
{
  const [ru] = enrichDrafts(
    [{ kind: 'simple', english: 'Привет! Как дела?', chinese: '你好！最近怎么样？' }],
    'Russian',
  );
  truthy('俄语仍会生成罗马音', Boolean(ru.romanization), JSON.stringify(ru.romanization));
  truthy('俄语仍会生成中文谐音', /[\u4e00-\u9fff]/.test(ru.chinesePronunciation || ''), ru.chinesePronunciation);
  eq('俄语 ipa 缺失时保持 undefined', ru.ipa, undefined);
}

// --------------------------------------------------------------------------- //
console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条`);
if (failures.length) {
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exit(1);
}
