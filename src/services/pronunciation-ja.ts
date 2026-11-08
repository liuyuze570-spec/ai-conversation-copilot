/**
 * 日语读音引擎（假名 + 汉字词典）。
 *
 * 为什么单独一个文件：0.5.0 的日语部分有四个真错误，全部出在那 40 行里 ——
 *   1. `toHiragana()` 只转换传入字符串的**第一个字符**，于是 `toHiragana('カメ')`
 *      返回 `'か'`（一个字符），却拿它去查 JA_MAP，命中单假名 → 指针前进 2 格，
 *      把「メ」整个吞掉：`カメラ → kara`、`カタカナ → kaka`。
 *      平假名输入不受影响（`かめら → kamera`），所以这个 bug 只出现在片假名上，
 *      而片假名恰恰是日语里外来词最常见的写法。
 *   2. 促音 っ 只补了一个辅音却不吃长音，`ガッコウ → gako`（少了 u）。
 *   3. `roman.endsWith(roman.slice(-1))` 恒为真 → 长音永远不补，`コーヒー → kohi`。
 *   4. 词典里没有的汉字原样输出，`空港 → 空港`，看着像罗马字其实一个音都没有。
 *
 * 现在的做法：**先逐字符把整串假名规范化**，再做多字符音节识别；
 * 长音/促音/拗音各自有明确规则；汉字只走词典，查不到就标「未确定」，
 * 绝不把汉字冒充成读音。
 */

/** 平假名 / 片假名互换（一次处理整串，不再只处理第一个字符）。 */
export function toHiraganaText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : char;
  }
  return out;
}

export function toKatakanaText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : char;
  }
  return out;
}

function isKanji(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    char === '々'
  );
}

function isKana(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x3041 && code <= 0x3096) || (code >= 0x30a1 && code <= 0x30f6) || char === 'ー';
}

/**
 * 假名 → [罗马字, 汉字近音]。
 *
 * 键一律是**平假名**：片假名在进来之前已经被 `toHiraganaText` 统一过，
 * 所以「カメラ」和「かめら」走的是同一张表、同一套规则，读音必然一致。
 */
const KANA: Record<string, [string, string]> = {
  あ: ['a', '阿'], い: ['i', '伊'], う: ['u', '乌'], え: ['e', '艾'], お: ['o', '奥'],
  か: ['ka', '卡'], き: ['ki', '基'], く: ['ku', '库'], け: ['ke', '凯'], こ: ['ko', '科'],
  が: ['ga', '嘎'], ぎ: ['gi', '基'], ぐ: ['gu', '古'], げ: ['ge', '盖'], ご: ['go', '高'],
  さ: ['sa', '萨'], し: ['shi', '西'], す: ['su', '苏'], せ: ['se', '塞'], そ: ['so', '索'],
  ざ: ['za', '扎'], じ: ['ji', '吉'], ず: ['zu', '兹'], ぜ: ['ze', '泽'], ぞ: ['zo', '佐'],
  た: ['ta', '塔'], ち: ['chi', '奇'], つ: ['tsu', '茨'], て: ['te', '泰'], と: ['to', '托'],
  だ: ['da', '达'], ぢ: ['ji', '吉'], づ: ['zu', '兹'], で: ['de', '戴'], ど: ['do', '多'],
  な: ['na', '纳'], に: ['ni', '尼'], ぬ: ['nu', '努'], ね: ['ne', '内'], の: ['no', '诺'],
  は: ['ha', '哈'], ひ: ['hi', '希'], ふ: ['fu', '夫'], へ: ['he', '海'], ほ: ['ho', '霍'],
  ば: ['ba', '巴'], び: ['bi', '比'], ぶ: ['bu', '布'], べ: ['be', '贝'], ぼ: ['bo', '波'],
  ぱ: ['pa', '帕'], ぴ: ['pi', '皮'], ぷ: ['pu', '普'], ぺ: ['pe', '佩'], ぽ: ['po', '坡'],
  ま: ['ma', '马'], み: ['mi', '米'], む: ['mu', '姆'], め: ['me', '梅'], も: ['mo', '莫'],
  や: ['ya', '亚'], ゆ: ['yu', '尤'], よ: ['yo', '约'],
  ら: ['ra', '拉'], り: ['ri', '里'], る: ['ru', '鲁'], れ: ['re', '雷'], ろ: ['ro', '罗'],
  わ: ['wa', '哇'], ゐ: ['i', '伊'], ゑ: ['e', '艾'], を: ['o', '奥'], ん: ['n', '恩'],
  ゔ: ['vu', '武'],
  // 拗音（两字符一个音节）
  きゃ: ['kya', '卡亚'], きゅ: ['kyu', '丘'], きょ: ['kyo', '乔'],
  しゃ: ['sha', '夏'], しゅ: ['shu', '休'], しょ: ['sho', '肖'],
  ちゃ: ['cha', '恰'], ちゅ: ['chu', '丘'], ちょ: ['cho', '乔'],
  にゃ: ['nya', '尼亚'], にゅ: ['nyu', '纽'], にょ: ['nyo', '纽'],
  ひゃ: ['hya', '希亚'], ひゅ: ['hyu', '休'], ひょ: ['hyo', '肖'],
  みゃ: ['mya', '米亚'], みゅ: ['myu', '谬'], みょ: ['myo', '谬'],
  りゃ: ['rya', '利亚'], りゅ: ['ryu', '留'], りょ: ['ryo', '廖'],
  ぎゃ: ['gya', '嘎亚'], ぎゅ: ['gyu', '久'], ぎょ: ['gyo', '乔'],
  じゃ: ['ja', '加'], じゅ: ['ju', '朱'], じょ: ['jo', '乔'],
  びゃ: ['bya', '比亚'], びゅ: ['byu', '比尤'], びょ: ['byo', '比奥'],
  ぴゃ: ['pya', '皮亚'], ぴゅ: ['pyu', '皮尤'], ぴょ: ['pyo', '皮奥'],
  // 外来语里常见的组合
  てぃ: ['ti', '提'], でぃ: ['di', '迪'], とぅ: ['tu', '图'], どぅ: ['du', '杜'],
  ふぁ: ['fa', '法'], ふぃ: ['fi', '菲'], ふぇ: ['fe', '费'], ふぉ: ['fo', '福'],
  うぇ: ['we', '韦'], うぃ: ['wi', '威'], ゔぁ: ['va', '瓦'], ゔぇ: ['ve', '维'],
};

/**
 * 汉字词典（键：汉字词，值：假名读音）。
 *
 * 这是**词典**而不是规则：日语汉字的读音没有可推导的规则（同じ「生」在
 * 生まれる/生活/一生里读法完全不同），硬套只会编出错误的音。所以这里只收
 * 本软件实际会遇到的词，查不到就明确标「未确定」。
 *
 * 词条由 AI 助手按常用读音逐条录入，**未由日语母语者逐条核对**——材料里
 * 必须这么写，不能声称「已核对」。
 */
const WORDS: Record<string, string> = {
  // 时间
  今日: 'きょう', 明日: 'あした', 昨日: 'きのう', 毎日: 'まいにち',
  今朝: 'けさ', 今晩: 'こんばん', 来週: 'らいしゅう', 来月: 'らいげつ', 来年: 'らいねん',
  先週: 'せんしゅう', 今週: 'こんしゅう', 今年: 'ことし', 去年: 'きょねん',
  月曜日: 'げつようび', 火曜日: 'かようび', 水曜日: 'すいようび',
  木曜日: 'もくようび', 金曜日: 'きんようび', 土曜日: 'どようび', 日曜日: 'にちようび',
  午前: 'ごぜん', 午後: 'ごご', 半: 'はん', 時: 'じ', 時間: 'じかん',
  一時間: 'いちじかん', 二時間: 'にじかん', 三十分: 'さんじゅっぷん', 十分: 'じゅっぷん',
  五分: 'ごふん', 十五分: 'じゅうごふん', 三時: 'さんじ', 四時: 'よじ',
  十時半: 'じゅうじはん', 朝: 'あさ', 昼: 'ひる', 夜: 'よる', 晩: 'ばん',
  週末: 'しゅうまつ', 平日: 'へいじつ', 祝日: 'しゅくじつ',
  // 数字 / 金额
  一: 'いち', 二: 'に', 三: 'さん', 四: 'よん', 五: 'ご', 六: 'ろく',
  七: 'なな', 八: 'はち', 九: 'きゅう', 十: 'じゅう', 百: 'ひゃく',
  千: 'せん', 万: 'まん', 円: 'えん', 金額: 'きんがく', 予算: 'よさん',
  五千: 'ごせん', 一万: 'いちまん', 一万五千: 'いちまんごせん', 五万: 'ごまん',
  半額: 'はんがく', 全部: 'ぜんぶ', 無料: 'むりょう', 有料: 'ゆうりょう',
  // 会议 / 工作
  会議: 'かいぎ', 予定: 'よてい', 変更: 'へんこう', 中止: 'ちゅうし', 延期: 'えんき',
  確認: 'かくにん', 資料: 'しりょう', 報告: 'ほうこく', 連絡: 'れんらく',
  説明: 'せつめい', 相談: 'そうだん', 質問: 'しつもん', 回答: 'かいとう',
  仕事: 'しごと', 会社: 'かいしゃ', 出張: 'しゅっちょう', 残業: 'ざんぎょう',
  締め切り: 'しめきり', 打ち合わせ: 'うちあわせ', 電話: 'でんわ', 番号: 'ばんごう',
  名前: 'なまえ', 住所: 'じゅうしょ', 担当: 'たんとう', 部長: 'ぶちょう',
  // 移动 / 场所
  空港: 'くうこう', 駅: 'えき', 電車: 'でんしゃ', 飛行機: 'ひこうき',
  新幹線: 'しんかんせん', 荷物: 'にもつ', 予約: 'よやく', 出発: 'しゅっぱつ',
  到着: 'とうちゃく', 遅れる: 'おくれる', 遅延: 'ちえん', 場所: 'ばしょ',
  家: 'いえ', 学校: 'がっこう', 病院: 'びょういん', 店: 'みせ', 部屋: 'へや',
  席: 'せき', 入口: 'いりぐち', 出口: 'でぐち', 受付: 'うけつけ',
  // 人 / 关系
  私: 'わたし', 僕: 'ぼく', 俺: 'おれ', 彼: 'かれ', 彼女: 'かのじょ',
  友達: 'ともだち', 家族: 'かぞく', 先生: 'せんせい', 学生: 'がくせい',
  子供: 'こども', 一人: 'ひとり', 二人: 'ふたり', 皆: 'みんな', 方: 'かた',
  // 沟通 / 状态
  日本語: 'にほんご', 英語: 'えいご', 中国語: 'ちゅうごくご', 言葉: 'ことば',
  文字: 'もじ', 字幕: 'じまく', 音声: 'おんせい', 意味: 'いみ', 翻訳: 'ほんやく',
  通訳: 'つうやく', 聴覚: 'ちょうかく', 障害: 'しょうがい', 障がい: 'しょうがい',
  手話: 'しゅわ', 読む: 'よむ', 書く: 'かく', 話す: 'はなす', 聞く: 'きく',
  見る: 'みる', 分かる: 'わかる', 分からない: 'わからない', 分かりません: 'わかりません',
  知る: 'しる', 思う: 'おもう', 言う: 'いう', 出来る: 'できる', 必要: 'ひつよう',
  大丈夫: 'だいじょうぶ', 問題: 'もんだい', 本当: 'ほんとう', 同じ: 'おなじ',
  違う: 'ちがう', 高い: 'たかい', 安い: 'やすい', 早い: 'はやい', 遅い: 'おそい',
  多い: 'おおい', 少ない: 'すくない', 大きい: 'おおきい', 小さい: 'ちいさい',
  難しい: 'むずかしい', 簡単: 'かんたん', 便利: 'べんり', 大変: 'たいへん',
  元気: 'げんき', 忙しい: 'いそがしい', 楽しい: 'たのしい', 嬉しい: 'うれしい',
  疲れた: 'つかれた', 好き: 'すき', 嫌い: 'きらい', 上手: 'じょうず', 下手: 'へた',
  // 常用整句 / 寒暄（含假名的整词，靠最长匹配命中）
  行く: 'いく', 行きます: 'いきます', 行きたい: 'いきたい', 行った: 'いった',
  来る: 'くる', 来ます: 'きます', 帰る: 'かえる', 帰ります: 'かえります',
  食べる: 'たべる', 食べます: 'たべます', 飲む: 'のむ', 飲みます: 'のみます',
  使う: 'つかう', 使います: 'つかいます', 買う: 'かう', 買います: 'かいます',
  待つ: 'まつ', 待って: 'まって', 会う: 'あう', 会います: 'あいます',
  作る: 'つくる', 始まる: 'はじまる', 始まります: 'はじまります',
  終わる: 'おわる', 終わります: 'おわります', 変わる: 'かわる',
  決める: 'きめる', 決まり: 'きまり', 送る: 'おくる', 送ります: 'おくります',
  // て形（送って）会被分词器切成「送 + って」，所以裸汉字也要有读音。
  送: 'おく',
  受け取る: 'うけとる', 持つ: 'もつ', 持って: 'もって', 入る: 'はいる',
  出る: 'でる', 座る: 'すわる', 立つ: 'たつ', 開ける: 'あける', 閉める: 'しめる',
  教える: 'おしえる', 覚える: 'おぼえる', 忘れる: 'わすれる',
  申し込む: 'もうしこむ',
  申し込み: 'もうしこみ', 取り消す: 'とりけす', 変更します: 'へんこうします',
  確認します: 'かくにんします', 送りますか: 'おくりますか',
  // 动词/形容词的词干：分词器会把「行きます」切成「行き + ます」，
  // 只收词干才认得出来。
  行き: 'いき', 食べ: 'たべ', 飲み: 'のみ', 使い: 'つかい', 買い: 'かい',
  待ち: 'まち', 会い: 'あい', 作り: 'つくり', 始まり: 'はじまり', 終わり: 'おわり',
  変わり: 'かわり', 決め: 'きめ', 送り: 'おくり', 持ち: 'もち', 入り: 'はいり',
  座り: 'すわり', 立ち: 'たち', 開け: 'あけ', 閉め: 'しめ', 教え: 'おしえ',
  覚え: 'おぼえ', 忘れ: 'わすれ', 取り消し: 'とりけし', 受け取り: 'うけとり',
  終わった: 'おわった', 始まった: 'はじまった', 変わった: 'かわった',
  着いた: 'ついた', 着く: 'つく', 遅れ: 'おくれ', 混んで: 'こんで',
  空いて: 'すいて', 空い: 'すい', 込ん: 'こん',
  ください: 'ください',
  こんにちは: 'こんにちわ', こんばんは: 'こんばんわ', おはよう: 'おはよう',
  ありがとう: 'ありがとう', ありがとうございます: 'ありがとうございます',
  すみません: 'すみません', ごめんなさい: 'ごめんなさい',
  お願いします: 'おねがいします', お願い: 'おねがい',
  もう一度: 'もういちど', ゆっくり: 'ゆっくり', ちょっと: 'ちょっと',
  久しぶり: 'ひさしぶり', お久しぶり: 'おひさしぶり', 初めまして: 'はじめまして',
  いただきます: 'いただきます', ごちそうさま: 'ごちそうさま',
  そうですか: 'そうですか', そうです: 'そうです', いいえ: 'いいえ',
  はい: 'はい', ええ: 'ええ', どうぞ: 'どうぞ', どうも: 'どうも',
  いくら: 'いくら', いつ: 'いつ', どこ: 'どこ', だれ: 'だれ', 何: 'なに',
  何時: 'なんじ', 何人: 'なんにん', どうして: 'どうして', なぜ: 'なぜ',
};

export interface JaUnit {
  /** 规范化之后的假名（汉字已换成读音） */
  kana: string;
  roman: string;
  zh: string;
  katakana: string;
  kind: 'kana' | 'sokuon' | 'long' | 'particle' | 'unknown';
  /** 未确定读音时的原样文字（汉字 / 生僻假名） */
  surface?: string;
}

export interface JaReading {
  units: JaUnit[];
  roman: string;
  zh: string;
  katakana: string;
  /** 没能确定读音的片段（原样汉字）。空数组 = 全部可读。 */
  unknown: string[];
  /** 音拍数（长音、促音各算一拍），用来做「提示长度合不合理」的粗校验。 */
  mora: number;
}

const EMPTY: JaReading = {
  units: [],
  roman: '',
  zh: '',
  katakana: '',
  unknown: [],
  mora: 0,
};

/** 解析一段假名（已规范化）。 */
function parseKana(text: string): JaUnit[] {
  const units: JaUnit[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    if (rest.startsWith('っ')) {
      /*
       * 促音（小っ）本身不发声，只是把下一个辅音憋一下。
       *
       * 以前它的中文近音写成「·」，于是「ガッコウ」标成「嘎·科乌」——
       * 中文近音里出现一个标点，用户以为那是要读出来的东西。
       * 现在它不贡献汉字，只把罗马字和后一个音节合并（见组装那一段）。
       */
      units.push({ kana: 'っ', roman: '', zh: '', katakana: 'ッ', kind: 'sokuon' });
      index += 1;
      continue;
    }
    if (rest.startsWith('ー')) {
      // 长音同理：罗马字里复写上一元音，中文近音不需要额外塞一个「ー」。
      units.push({ kana: 'ー', roman: '', zh: '', katakana: 'ー', kind: 'long' });
      index += 1;
      continue;
    }
    const pair = KANA[rest.slice(0, 2)];
    if (pair && rest.length >= 2) {
      units.push({
        kana: rest.slice(0, 2),
        roman: pair[0],
        zh: pair[1],
        katakana: toKatakanaText(rest.slice(0, 2)),
        kind: 'kana',
      });
      index += 2;
      continue;
    }
    const single = KANA[rest[0]];
    if (single) {
      units.push({
        kana: rest[0],
        roman: single[0],
        zh: single[1],
        katakana: toKatakanaText(rest[0]),
        kind: 'kana',
      });
      index += 1;
      continue;
    }
    // 不认识的假名（ゐゑ 之外的古假名、半角残留等）：标注，不猜。
    units.push({
      kana: rest[0],
      roman: '',
      zh: '',
      katakana: rest[0],
      kind: 'unknown',
      surface: rest[0],
    });
    index += 1;
  }
  return units;
}

/**
 * 把一段原文切成「可读片段 / 未确定片段」。
 *
 * 两条规则是这里的关键：
 * 1. **词典匹配对每个位置都做，不只在汉字上做**。像「もう一度」这种
 *    「假名 + 汉字」混写的词，只在汉字位查表是永远查不到的 ——
 *    以前就是这样把「度」当成了不认识的汉字。
 * 2. **连续的假名攒成一段再交给音节解析**。逐字符交出去的话，
 *    「きょう」会被拆成 き / ょ / う 三个字，拗音 きょ 永远匹配不上，
 *    读出来变成 `kiu`。
 */
function resolve(text: string): { chunk: string; unknown?: string }[] {
  const parts: { chunk: string; unknown?: string }[] = [];
  let index = 0;
  let kanaRun = '';
  const flush = () => {
    if (kanaRun) {
      parts.push({ chunk: kanaRun });
      kanaRun = '';
    }
  };

  while (index < text.length) {
    let matchedSize = 0;
    let matchedReading = '';
    for (let size = Math.min(8, text.length - index); size >= 2; size -= 1) {
      const slice = text.slice(index, index + size);
      if (![...slice].some(isKanji)) continue;
      const reading = WORDS[slice];
      if (reading) {
        matchedSize = size;
        matchedReading = reading;
        break;
      }
    }
    if (matchedSize) {
      flush();
      parts.push({ chunk: matchedReading });
      index += matchedSize;
      continue;
    }

    const char = text[index];
    if (isKanji(char)) {
      const single = WORDS[char];
      flush();
      if (single) {
        parts.push({ chunk: single });
        index += 1;
        continue;
      }
      // 查不到：连续汉字收成一个「未确定」片段，明确标注，不冒充读音。
      let run = '';
      while (index < text.length && isKanji(text[index])) {
        run += text[index];
        index += 1;
      }
      parts.push({ chunk: '', unknown: run });
      continue;
    }
    kanaRun += char;
    index += 1;
  }
  flush();
  return parts;
}

/**
 * 读一段日语（可能含汉字）。
 *
 * 返回的 `roman` / `zh` / `katakana` 一定来自同一遍解析，所以「罗马字」和
 * 「片假名」不会出现一个有一个没有的情况。
 */
export function readJapanese(text: string): JaReading {
  const raw = String(text ?? '');
  if (!raw.trim()) return EMPTY;

  // 先整串规范化（片假名 → 平假名），后面的所有判断和查表都基于同一份文本。
  const whole = toHiraganaText(raw.trim());

  /*
   * 整词词典先看一眼。
   *
   * 「こんにちは」这种纯假名整词不会走汉字查表，但它的习惯读法是
   * こんにちわ（wa），不是逐字读 ha。整词命中时直接按词典读，
   * 逐字拼出来的「konnichiha」是错的。
   */
  const wholeReading = WORDS[whole];
  const parts: { chunk: string; unknown?: string }[] =
    wholeReading && wholeReading !== whole ? [{ chunk: wholeReading }] : resolve(whole);
  const units: JaUnit[] = [];
  const unknown: string[] = [];

  // 单独的助词：は 读 wa、へ 读 e、を 读 o。整词只有一个假名时才这么判，
  // 免得把「はな」读成「わな」。
  const particle: Record<string, [string, string, string]> = {
    は: ['wa', '哇', 'ワ'],
    へ: ['e', '艾', 'エ'],
    を: ['o', '奥', 'ヲ'],
  };

  for (const part of parts) {
    if (part.unknown) {
      unknown.push(part.unknown);
      units.push({
        kana: '',
        roman: '',
        zh: '',
        katakana: toKatakanaText(part.unknown),
        kind: 'unknown',
        surface: part.unknown,
      });
      continue;
    }
    /*
     * 助词判定：一段**单独成块**的 は / へ / を 就是助词。
     *
     * `resolve()` 会把连续假名攒成一段，所以「会議は」里的「は」自己就是一段，
     * 而「はな」「こんにちは」是一整段 —— 后者不会被误读成 wana / konnichiwa 之外
     * 的东西。之前只认「整句就是一个假名」，于是「会議は」读成 kaigiha。
     */
    const chunkHira = toHiraganaText(part.chunk);
    if (chunkHira.length === 1 && particle[chunkHira]) {
      const [roman, zh, katakana] = particle[chunkHira];
      units.push({ kana: chunkHira, roman, zh, katakana, kind: 'particle' });
      continue;
    }
    units.push(...parseKana(part.chunk));
  }

  // 组装：促音把下一个辅音拉长，长音把上一个元音再读一遍。
  let roman = '';
  let pendingGeminate = false;
  for (const unit of units) {
    if (unit.kind === 'sokuon') {
      pendingGeminate = true;
      continue;
    }
    if (unit.kind === 'long') {
      const vowel = roman.match(/[aeiou]$/);
      if (vowel) roman += vowel[0];
      continue;
    }
    if (!unit.roman) continue;
    roman += pendingGeminate ? unit.roman[0] + unit.roman : unit.roman;
    pendingGeminate = false;
  }

  return {
    units,
    roman,
    zh: units.map((unit) => unit.zh || (unit.surface ? unit.surface : '')).join(''),
    katakana: units.map((unit) => unit.katakana).join(''),
    unknown,
    mora: units.length,
  };
}

/** 日语按音拍切分（用于「分块」那一行，不是按字符数均分）。 */
export function jaChunks(text: string): string[] {
  const reading = readJapanese(text);
  if (!reading.units.length) return text ? [text] : [];
  const chunks: string[] = [];
  for (const unit of reading.units) {
    if (unit.kind === 'sokuon') {
      // 促音并进后一个块，读起来才是一个整体
      if (chunks.length) chunks[chunks.length - 1] += unit.kana;
      else chunks.push(unit.kana);
      continue;
    }
    if (unit.kind === 'long') {
      if (chunks.length) chunks[chunks.length - 1] += unit.kana;
      else chunks.push(unit.kana);
      continue;
    }
    chunks.push(unit.surface ?? unit.kana);
  }
  return chunks;
}
