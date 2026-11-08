/**
 * Offline pronunciation helpers for every supported target language.
 *
 * The LLM usually returns ipa / syllables / chinesePronunciation, but we never
 * rely on it: these fallbacks make sure every suggestion is still speakable
 * when a provider returns partial data or when running in Mock mode.
 *
 * Chinese hints are built from consonant+vowel PAIRS (ba→巴, ri→瑞) so the
 * sound actually lines up with the English, instead of letter-by-letter
 * guessing. Russian / Japanese / Korean additionally get a Latin romanization.
 */
import type { TargetLanguage } from '../shared/types';
import type { HintSystem } from '../shared/languages';
import { findCustomReading, type CustomReading } from '../shared/reading-dictionary';
import { jaChunks, readJapanese } from './pronunciation-ja';
import { enToKatakana } from './pronunciation-katakana';

// ------------------------------------------------------------------ English

/** Words whose natural transliteration is worth hard-coding. */
const WORD_SOUNDS: Record<string, string> = {
  hello: '哈喽', hi: '嗨', hey: '嘿', sorry: '骚瑞', thanks: '三克斯',
  thank: '三克', you: '优', really: '瑞尔利', good: '古德', great: '格瑞特',
  nice: '奈斯', cool: '库尔', awesome: '奥森姆', interesting: '因吹斯汀',
  beautiful: '比优特佛', food: '福德', city: '西提', weekend: '威肯德',
  tomorrow: '特莫柔', today: '特得', maybe: '梅比', sure: '舒尔', okay: '欧凯',
  yes: '耶斯', no: '弄', because: '比靠斯', about: '额包特', think: '辛克',
  like: '赖克', love: '拉夫', want: '王特', need: '尼德', know: '弄',
  understand: '昂德斯坦德', please: '普利斯', again: '额根', slow: '斯洛',
  slowly: '斯洛利', speak: '斯批克', say: '赛', hear: '希尔', listen: '立森',
  wait: '维特', minute: '米尼特', time: '太姆', work: '沃克',
  recommend: '瑞克曼德', travel: '揣佛', visit: '威兹特', english: '英格利什', excited: '伊克赛提德', tired: '太尔德', happy: '海皮',
  hungry: '航格瑞', late: '雷特', traffic: '揣菲克', flight: '弗赖特',
  delayed: '迪雷德', frustrating: '弗拉斯特瑞廷', ridiculous: '瑞迪克勒斯', // --- high-frequency words (keep the hint matching the real sound) ---
  i: '艾', it: '伊特', is: '伊兹', am: '艾姆', are: '阿尔', was: '沃兹',
  were: '沃尔', do: '杜', dont: '洞特', not: '诺特', just: '加斯特',
  so: '索', very: '维瑞', much: '马奇', many: '梅尼', lot: '洛特',
  have: '海夫', has: '海兹', had: '海德', will: '威尔', would: '伍德',
  can: '坎', cant: '坎特', could: '库德', should: '舒德', honestly: '奥内斯特利', sounds: '桑兹', sound: '桑德', thing: '辛',
  things: '辛兹', people: '皮剖', something: '萨姆辛', anything: '埃尼辛', week: '威克', night: '奈特',
  morning: '莫宁', evening: '伊夫宁', home: '霍姆', house: '豪斯',
  friend: '弗伦德', friends: '弗伦兹', family: '法梅利',
  disappointed: '迪萨波因提德', frustrated: '弗拉斯特瑞提德', nervous: '讷尔沃斯', worried: '沃瑞德',
  sad: '赛德', mad: '麦德', upset: '阿普赛特', angry: '安格瑞',
  boring: '博瑞英', busy: '比兹', sick: '西克',
  better: '贝特', best: '贝斯特', worse: '沃尔', right: '赖特',
  wrong: '荣', true: '楚', crazy: '克瑞兹', wild: '外尔德', dude: '杜德',
  bro: '布柔', man: '曼', girl: '格尔', guy: '盖',
  coffee: '咖啡', dinner: '迪讷', lunch: '兰奇', water: '沃特',
  movie: '木维', music: '谬兹克', game: '给姆', party: '帕提',
  weather: '韦泽', rain: '瑞恩', cold: '扣德', hot: '哈特',
  money: '马尼', price: '普赖斯', cheap: '奇普', expensive: '伊克彭西夫', problem: '普绕布勒姆', question: '奎斯陈', hour: '奥尔', later: '雷特', now: '闹',
  here: '希尔', there: '泽尔', where: '威尔', when: '温',
  what: '沃特', why: '外', how: '豪', who: '胡',
  // --- function words the pair table would get wrong (th-, -oo-, -er) ---
  this: '迪斯', that: '泽特', these: '迪兹', those: '柔兹', they: '泽伊',
  them: '泽姆', then: '泽恩', than: '泽恩', their: '泽尔',
  with: '威兹', without: '威曹特', the: '德', and: '安德', but: '巴特',
  look: '卢克', looks: '卢克斯', looking: '卢金', book: '布克',
  school: '斯库尔', room: '鲁姆', anyone: '埃尼万',
  somebody: '萨姆巴迪', nobody: '弄巴迪', actually: '阿克楚利',
  never: '内弗尔', ever: '埃弗尔', every: '埃弗里', 
  favorite: '费沃瑞特', gonna: '卦那', wanna: '瓦那', kinda: '凯恩达',
  yeah: '耶', bye: '拜', welcome: '威尔卡姆', help: '亥尔普',
  stop: '斯托普', start: '斯塔特', try: '揣', give: '给夫',
  take: '忒克', make: '梅克', came: '凯姆', going: '高英',
  gone: '高恩', get: '盖特', got: '高特', saw: '索', knew: '纽',
  thought: '索特', feel: '菲尔', felt: '费尔特', mean: '民',
  driving: '德赖文', drive: '德赖夫', idea: '艾迪亚', believe: '比利夫',
  honest: '奥内斯特', worry: '沃瑞', your: '约尔', lets: '莱茨',
  let: '莱特', starving: '斯塔文', long: '朗', see: '西', sea: '西',
  /*
   * 会议 / 日程 / 金额场景的高频词。
   *
   * 这些词在这个软件的主任务（约时间、对金额、改期）里几乎每场都有，
   * 而规则拼读对它们恰好最容易出错（report→瑞波尔特、budget→布吉特、
   * Monday→莫恩达伊）。查表比按字母拼更接近真实读音，所以单独收进来。
   * 注意：这是**按音标整理的近似表**，不是母语者核对过的结果，界面上
   * 仍然只是「汉字近似」，不能当成已核对。
   */
  monday: '曼德伊', tuesday: '图兹德伊', wednesday: '温兹德伊',
  thursday: '瑟兹德伊', friday: '弗赖德伊', saturday: '萨特德伊',
  sunday: '桑德伊', weekdays: '威克德伊兹',
  january: '詹纽埃瑞', february: '费布茹埃瑞', march: '玛奇',
  april: '埃普瑞尔', may: '梅', june: '朱恩', july: '朱莱',
  august: '奥格斯特', september: '塞普坦伯', october: '奥克托伯',
  november: '诺文伯', december: '迪森伯',
  meeting: '米廷', budget: '巴吉特', report: '瑞波特', send: '森德',
  sent: '森特', email: '伊梅尔', mail: '梅尔', dollar: '达勒',
  dollars: '达勒斯', amount: '阿芒特', total: '托特尔', invoice: '因沃伊斯',
  contract: '康特拉克特', deadline: '戴德莱恩', confirm: '康弗姆',
  schedule: '斯凯久尔', delivery: '迪利弗瑞', deliver: '迪利弗',
  available: '阿维勒波', until: '安提尔', next: '内克斯特', code: '科德',
  afternoon: '艾夫特努恩', including: '因克鲁丁',
  include: '因克鲁德', tax: '塔克斯', order: '奥尔德',
  sign: '赛恩', change: '钱吉', transfer: '特兰斯弗', account: '阿康特',
  address: '阿德瑞斯', phone: '福恩', number: '南伯', office: '奥菲斯',
  company: '康姆帕尼', client: '克莱恩特', project: '普若杰克特',
  percent: '珀森特', discount: '迪斯考恩特', quote: '阔特', approval: '阿普如沃',
  move: '穆夫', moved: '穆夫德', moving: '穆文', changed: '钱吉德',
  /*
   * 短功能词。规则拼读对它们的错误率最高（from→夫若姆、by→被拼成两段），
   * 而它们几乎出现在每个句子里。
   */
  by: '拜', from: '弗若姆', at: '艾特', to: '图', in: '因', on: '昂',
  for: '福尔', of: '奥夫', or: '奥尔', if: '伊夫', as: '艾兹',
  be: '比', been: '宾', being: '比英', does: '达兹', did: '迪德', done: '丹',
  // 「让对方再说一遍 / 回个电话」这类最常用的短句成分
  call: '考尔', called: '考尔德', me: '米', we: '威', us: '阿斯',
  back: '拜克', day: '德伊', days: '德伊兹',
  accept: '阿克塞普特', repeat: '瑞皮特', pardon: '帕登',
  ill: '艾尔', im: '艾姆', its: '伊茨', thats: '泽茨', wont: '沃恩特',
};

/**
 * Consonant + vowel pairs. This is what makes the hint sound like the word:
 * "like" → lai? no: li→里 + ke→克 would read 里克, so "like" is handled by the
 * silent-e rule first and becomes li→赖? We keep the most common readings here.
 */
const EN_CV: Record<string, string> = {
  ba: '巴', be: '贝', bi: '比', bo: '波', bu: '布', by: '拜',
  ca: '卡', ce: '塞', ci: '西', co: '科', cu: '库', cy: '赛',
  da: '达', de: '德', di: '迪', do: '多', du: '杜', dy: '戴',
  fa: '法', fe: '费', fi: '菲', fo: '福', fu: '富', fy: '费',
  ga: '盖', ge: '杰', gi: '吉', go: '高', gu: '古', gy: '杰',
  ha: '哈', he: '希', hi: '海', ho: '霍', hu: '胡', hy: '海',
  ja: '贾', je: '杰', ji: '吉', jo: '乔', ju: '朱', jy: '杰',
  ka: '卡', ke: '凯', ki: '基', ko: '科', ku: '库', ky: '凯',
  la: '拉', le: '勒', li: '里', lo: '洛', lu: '鲁', ly: '莱',
  ma: '马', me: '梅', mi: '米', mo: '莫', mu: '穆', my: '麦',
  na: '纳', ne: '内', ni: '尼', no: '诺', nu: '努', ny: '奈',
  pa: '帕', pe: '佩', pi: '皮', po: '波', pu: '普', py: '派',
  ra: '拉', re: '瑞', ri: '瑞', ro: '若', ru: '如', ry: '赖',
  sa: '萨', se: '塞', si: '西', so: '索', su: '苏', sy: '赛',
  ta: '塔', te: '特', ti: '提', to: '托', tu: '图', ty: '泰',
  va: '瓦', ve: '维', vi: '维', vo: '沃', vu: '武', vy: '维',
  wa: '瓦', we: '威', wi: '威', wo: '沃', wu: '伍', wy: '怀',
  za: '扎', ze: '泽', zi: '齐', zo: '佐', zu: '祖', zy: '再',
  ya: '亚', ye: '耶', yi: '伊', yo: '约', yu: '尤',
  xa: '克萨', xe: '克塞', xi: '克西', xo: '克索', xu: '克苏',
  qua: '夸', que: '奎', qui: '奎', quo: '阔',
  cha: '查', che: '切', chi: '奇', cho: '乔', chu: '丘',
  sha: '沙', she: '希', shi: '希', sho: '肖', shu: '舒',
  tha: '撒', the: '德', thi: '辛', tho: '索', thu: '苏', thy: '赛',
  pha: '法', phe: '菲', phi: '菲', pho: '福', phu: '富',
  wha: '沃', whe: '威', whi: '威', who: '胡',
  kna: '纳', kne: '尼', kni: '尼', kno: '诺', knu: '纽',
  tra: '特拉', tre: '特瑞', tri: '特里', tro: '特若', tru: '特鲁', try: '特赖',
  dra: '德拉', dre: '德瑞', dri: '德里', dro: '德若', dru: '德鲁', dry: '德赖',
};

/** Vowel teams, digraphs and endings (checked after the CV pairs). */
const EN_GROUPS: [string, string][] = [
  ['tion', '申'], ['sion', '仁'], ['ture', '切尔'], ['sure', '舒尔'],
  ['ough', '奥夫'], ['augh', '奥夫'], ['eigh', '诶'], ['ight', '艾特'],
  ['ing', '英'], ['ang', '昂'], ['ong', '翁'], ['ung', '昂'],
  ['ent', '恩特'], ['ant', '安特'], ['est', '斯特'], ['ist', '伊斯特'],
  ['ain', '艾因'], ['air', '艾尔'], ['are', '艾尔'], ['ere', '伊尔'],
  ['ire', '艾尔'], ['ore', '奥尔'], ['ure', '尤尔'], ['our', '奥尔'],
  ['ai', '艾'], ['ay', '艾'], ['au', '奥'], ['aw', '奥'], ['ea', '伊'],
  ['ee', '伊'], ['ei', '诶'], ['ey', '诶'], ['eu', '尤'], ['ew', '尤'],
  ['ie', '艾'], ['oa', '欧'], ['oe', '欧'], ['oi', '欧伊'], ['oy', '欧伊'],
  ['oo', '乌'], ['ou', '奥'], ['ow', '欧'], ['ue', '乌'], ['ui', '乌伊'],
  ['ar', '阿尔'], ['er', '厄'], ['ir', '厄'], ['or', '奥尔'], ['ur', '厄'],
  ['tch', '奇'], ['dge', '吉'], ['ck', '克'], ['ph', '夫'], ['gh', ''],
  ['kn', '尼'], ['wr', '若'], ['qu', '克'], ['mb', '姆'], ['gn', '尼'],
  ['ng', '恩'], ['nk', '恩克'], ['nt', '恩特'], ['mp', '姆普'],
  ['tr', '特'], ['dr', '德'], ['ts', '茨'], ['ds', '兹'],
  ['str', '斯特'], ['spr', '斯普'], ['scr', '斯克'],
  ['ful', '夫尔'], ['ment', '门特'], ['ness', '尼斯'], ['able', '额波'],
  ['ly', '利'], ['es', '斯'],
];

const VOWELS = 'aeiou';

function isVowel(letter: string) {
  return VOWELS.includes(letter);
}

/** Drop a trailing silent "e" (make / nice / like / there). */
function stripSilentE(word: string): string {
  if (word.length <= 3 || !word.endsWith('e')) return word;
  const before = word[word.length - 2];
  if (isVowel(before)) return word;
  const vowelCount = [...word].filter(isVowel).length;
  return vowelCount >= 2 ? word.slice(0, -1) : word;
}

/** Collapse doubled consonants so they are not pronounced twice. */
function collapseDoubles(word: string): string {
  return word.replace(/([bcdfghjklmnpqrstvwxz])\1+/g, '$1');
}

/** Table lookup, also trying the silent-e spelling (lik → like). */
function knownSound(word: string): string | undefined {
  return WORD_SOUNDS[word] ?? (word.length >= 3 ? WORD_SOUNDS[`${word}e`] : undefined);
}

/**
 * 英文字母名（A-Z）的汉字近音。
 *
 * 缩写不能走「字母→读音」以外的方式：「PDF」逐字母硬拼成「普德夫」、
 * 「QR」拼成「克尔」，使用者照着念对方根本听不懂 —— 那不是近似，是错。
 */
const LETTER_SOUNDS: Record<string, string> = {
  a: '诶', b: '比', c: '西', d: '迪', e: '伊', f: '艾夫', g: '吉',
  h: '诶吃', i: '艾', j: '杰', k: '凯', l: '艾尔', m: '艾姆', n: '恩',
  o: '欧', p: '匹', q: '丘', r: '阿尔', s: '艾斯', t: '提', u: '优',
  v: '维', w: '达布留', x: '艾克斯', y: '歪', z: '泽德',
};

/**
 * 称谓 / 常见缩写的整词读法。
 *
 * 这些按字母念反而不对（没人把 Mr. 念成「艾姆阿尔」），所以单独给整词读法。
 */
const ABBREV_SOUNDS: Record<string, string> = {
  mr: '米斯特', mrs: '米西兹', ms: '米兹', dr: '达克特', prof: '普罗费瑟',
  st: '斯特里特', jr: '朱尼尔', sr: '西尼尔',
  am: '诶艾姆', pm: '皮艾姆', ok: '欧凯', vs: '维尔瑟斯',
  etc: '艾特塞特拉', hr: '诶吃阿尔', pr: '皮阿尔', ceo: '西伊欧',
};

/**
 * 称谓缩写：大小写混写（`Mr` / `Dr`）也要认。
 *
 * 原文里 `Mr. Okafor` 被分词器切成 `Mr`（点被丢掉），全大写规则匹配不到，
 * 就落到「逐字母拼」去了 —— 结果是「姆尔」，听着像另一个词。
 */
const TITLE_WORDS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr']);

/**
 * 缩写怎么念。返回 undefined 表示「这不是缩写，按普通单词处理」。
 *
 * 两种识别方式：
 *  - 带点缩写（`p.m.` / `Mr.` / `etc.`）：去掉点查表
 *  - 全大写 2–5 个字母（`PDF` / `QR` / `USB`）：按字母名逐个念，标「规则近似」
 *
 * 全大写的也可能是能拼读的缩略词（NASA），程序分不出来，所以这种情况
 * 一律标近似、不冒充已核对 —— 使用者一眼能看出「这行要自己确认」。
 */
function readEnglishAbbreviation(raw: string): { hint: string; approx: boolean } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const bare = trimmed.replace(/\./g, '').toLowerCase();
  const dotted = /^([A-Za-z]{1,4}\.)+[A-Za-z]{0,4}\.?$/.test(trimmed);
  if (dotted && ABBREV_SOUNDS[bare]) return { hint: ABBREV_SOUNDS[bare], approx: false };
  // 分词器会把 `Mr.` 切成 `Mr`，点没了也要按称谓念。
  if (TITLE_WORDS.has(bare)) return { hint: ABBREV_SOUNDS[bare], approx: false };
  const caps = /^[A-Z]{2,5}s?$/.test(trimmed);
  if (caps) {
    if (ABBREV_SOUNDS[bare]) return { hint: ABBREV_SOUNDS[bare], approx: false };
    const letters = bare.replace(/s$/, '').split('');
    return {
      hint: letters.map((ch) => LETTER_SOUNDS[ch] ?? ch).join(' '),
      approx: true,
    };
  }
  return undefined;
}

function enTransliterateWord(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!clean) return '';
  // Look the word up BEFORE any silent-e / doubling surgery: "like" is in the
  // table, "lik" is not, and the table is what keeps hints honest.
  const direct = knownSound(clean);
  if (direct) return direct;

  // Past-tense / plural endings first, so a CV pair cannot swallow the vowel.
  const suffix = clean.match(/^(.+?)(ed|es)$/);
  if (suffix && suffix[1].length >= 2) {
    const base = suffix[1];
    const ending = suffix[2];
    const last = base[base.length - 1];
    if (ending === 'ed' && !isVowel(last)) {
      const head = knownSound(base) ?? enTransliterateWord(base);
      return head + ('td'.includes(last) ? '伊德' : 'pkfsxh'.includes(last) ? '特' : '德');
    }
    if (ending === 'es' && 'sxzh'.includes(last)) {
      return `${knownSound(base) ?? enTransliterateWord(base)}伊兹`;
    }
  }

  const word = collapseDoubles(stripSilentE(clean));
  const stripped = knownSound(word);
  if (stripped) return stripped;

  let out = '';
  let index = 0;
  while (index < word.length) {
    const rest = word.slice(index);

    // -ed endings: /t/ after a voiceless consonant, /d/ otherwise, /ɪd/ after t/d.
    if (rest === 'ed' && index > 0) {
      const prev = word[index - 1];
      out += 'td'.includes(prev) ? '伊德' : 'pkfsxh'.includes(prev) ? '特' : '德';
      break;
    }

    // 3-letter pairs (tra / qui / sha / thi ...)
    const triple = EN_CV[rest.slice(0, 3)];
    if (triple) {
      out += triple;
      index += 3;
      continue;
    }
    // consonant + vowel
    const pair = EN_CV[rest.slice(0, 2)];
    if (pair) {
      out += pair;
      index += 2;
      continue;
    }
    // vowel teams / digraphs / endings
    const group = EN_GROUPS.find(([pattern]) => rest.startsWith(pattern));
    if (group) {
      out += group[1];
      index += group[0].length;
      continue;
    }

    const letter = word[index];
    const next = word[index + 1] ?? '';
    const nextIsConsonant = next !== '' && !isVowel(next);
    const soft = 'eiy'.includes(next);

    if (isVowel(letter)) {
      if (letter === 'a') out += nextIsConsonant ? '艾' : next === '' ? '厄' : '阿';
      else if (letter === 'e') out += nextIsConsonant ? '艾' : '伊';
      else if (letter === 'i') out += nextIsConsonant ? '伊' : '艾';
      else if (letter === 'o') out += nextIsConsonant ? '奥' : '欧';
      else if (letter === 'u') out += nextIsConsonant ? '阿' : '尤';
      index += 1;
      continue;
    }

    const single: Record<string, string> = {
      b: '布', d: '德', f: '夫', h: '赫', j: '吉', k: '克', l: '尔',
      m: '姆', n: '恩', p: '普', q: '克', r: '尔', s: '斯', t: '特',
      v: '夫', w: '乌', x: '克斯', y: '伊', z: '兹',
    };
    if (letter === 'c') out += soft ? '斯' : '克';
    else if (letter === 'g') out += soft ? '吉' : '格';
    else out += single[letter] ?? letter;
    index += 1;
  }
  return out;
}

/** Split one English word into readable syllable chunks, e.g. interested -> in-ter-est-ed */
export function syllablesOfWord(word: string): string[] {
  const clean = word.toLowerCase().replace(/[^a-z]/g, '');
  if (clean.length <= 3) return [word];

  const groups: { start: number; end: number }[] = [];
  let index = 0;
  while (index < clean.length) {
    if ('aeiouy'.includes(clean[index])) {
      let end = index;
      while (end < clean.length && 'aeiouy'.includes(clean[end])) end += 1;
      // Treat a trailing silent "e" as part of the previous syllable.
      if (end === clean.length && end - index === 1 && clean[index] === 'e' && groups.length) break;
      groups.push({ start: index, end });
      index = end;
    } else {
      index += 1;
    }
  }

  if (groups.length <= 1) return [word];

  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const nextVowelStart = groups[i + 1]?.start ?? clean.length;
    const consonants = clean.slice(group.end, nextVowelStart);
    const keep = i === groups.length - 1 ? consonants.length : Math.min(1, consonants.length);
    const end = group.end + keep;
    parts.push(clean.slice(cursor, Math.max(end, group.end)));
    cursor = Math.max(end, group.end);
  }
  if (cursor < clean.length) parts.push(clean.slice(cursor));

  const result = parts.filter(Boolean);
  if (result.length && /^[A-Z]/.test(word)) {
    result[0] = result[0].charAt(0).toUpperCase() + result[0].slice(1);
  }
  return result.length ? result : [word];
}

// ------------------------------------------------------------------ Russian

const RU_MAP: Record<string, [string, string]> = {
  а: ['a', '阿'], б: ['b', '布'], в: ['v', '夫'], г: ['g', '格'],
  д: ['d', '德'], е: ['ye', '耶'], ё: ['yo', '约'], ж: ['zh', '日'],
  з: ['z', '兹'], и: ['i', '伊'], й: ['y', '伊'], к: ['k', '克'],
  л: ['l', '尔'], м: ['m', '姆'], н: ['n', '恩'], о: ['o', '奥'],
  п: ['p', '普'], р: ['r', '尔'], с: ['s', '斯'], т: ['t', '特'],
  у: ['u', '乌'], ф: ['f', '夫'], х: ['kh', '赫'], ц: ['ts', '茨'],
  ч: ['ch', '奇'], ш: ['sh', '什'], щ: ['shch', '什奇'], ъ: ['', ''],
  ы: ['y', '厄'], ь: ['', ''], э: ['e', '艾'], ю: ['yu', '尤'],
  я: ['ya', '亚'],
};
/**
 * Consonant + vowel readings. Russian syllables really are CV, so mapping the
 * pair avoids the "п-р-и" → 普尔伊 nonsense you get letter by letter.
 */
const RU_CV: Record<string, [string, string]> = {
  ба: ['ba', '巴'], бя: ['bya', '比亚'], ва: ['va', '瓦'], вя: ['vya', '维亚'],
  га: ['ga', '嘎'], да: ['da', '达'], дя: ['dya', '贾'], жа: ['zha', '扎'],
  за: ['za', '扎'], ка: ['ka', '卡'], ла: ['la', '拉'], ля: ['lya', '利亚'],
  ма: ['ma', '马'], мя: ['mya', '米亚'], на: ['na', '纳'], ня: ['nya', '尼亚'],
  па: ['pa', '帕'], пя: ['pya', '皮亚'], ра: ['ra', '拉'], ря: ['rya', '里亚'],
  са: ['sa', '萨'], ся: ['sya', '夏'], та: ['ta', '塔'], тя: ['tya', '恰'],
  фа: ['fa', '法'], ха: ['kha', '哈'], ца: ['tsa', '察'], ча: ['cha', '恰'],
  ша: ['sha', '沙'], ща: ['shcha', '夏'],
  бе: ['bye', '别'], ве: ['vye', '维耶'], ге: ['gye', '盖'], де: ['dye', '杰'],
  же: ['zhe', '热'], зе: ['zye', '泽'], ке: ['kye', '凯'], ле: ['lye', '列'],
  ме: ['mye', '灭'], не: ['nye', '涅'], пе: ['pye', '撇'], ре: ['rye', '列'],
  се: ['sye', '谢'], те: ['tye', '切'], фе: ['fye', '费'], хе: ['khye', '黑'],
  це: ['tsye', '采'], че: ['che', '切'], ше: ['she', '舍'], ще: ['shche', '谢'],
  би: ['bi', '比'], ви: ['vi', '维'], ги: ['gi', '吉'], ди: ['di', '迪'],
  жи: ['zhi', '日'], зи: ['zi', '济'], ки: ['ki', '基'], ли: ['li', '里'],
  ми: ['mi', '米'], ни: ['ni', '尼'], пи: ['pi', '皮'], ри: ['ri', '里'],
  си: ['si', '西'], ти: ['ti', '季'], фи: ['fi', '菲'], хи: ['khi', '希'],
  ци: ['tsi', '齐'], чи: ['chi', '奇'], ши: ['shi', '希'], щи: ['shchi', '希'],
  бо: ['bo', '博'], во: ['vo', '沃'], го: ['go', '高'], до: ['do', '多'],
  жо: ['zho', '若'], зо: ['zo', '佐'], ко: ['ko', '科'], ло: ['lo', '洛'],
  лё: ['lyo', '廖'], мо: ['mo', '莫'], но: ['no', '诺'], нё: ['nyo', '尼奥'],
  по: ['po', '波'], ро: ['ro', '罗'], рё: ['ryo', '廖'], со: ['so', '索'],
  сё: ['syo', '肖'], то: ['to', '托'], тё: ['tyo', '乔'], фо: ['fo', '福'],
  хо: ['kho', '霍'], цо: ['tso', '措'], чо: ['cho', '乔'], шо: ['sho', '绍'],
  бу: ['bu', '布'], ву: ['vu', '武'], гу: ['gu', '古'], ду: ['du', '杜'],
  зу: ['zu', '祖'], ку: ['ku', '库'], лу: ['lu', '卢'], лю: ['lyu', '柳'],
  му: ['mu', '穆'], ну: ['nu', '努'], ню: ['nyu', '纽'], пу: ['pu', '普'],
  ру: ['ru', '鲁'], рю: ['ryu', '留'], су: ['su', '苏'], сю: ['syu', '休'],
  ту: ['tu', '图'], тю: ['tyu', '秋'], fu: ['fu', '富'], цу: ['tsu', '楚'],
  чу: ['chu', '丘'], шу: ['shu', '舒'],
};

const RU_VOWELS = 'аеёиоуыэюя';

function ruSyllables(word: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const letter of word) {
    if (RU_VOWELS.includes(letter)) {
      // Consonants before a vowel start a new syllable unless we are at the start.
      if (current && !RU_VOWELS.includes(current[current.length - 1])) {
        const pivot = current.search(/[^аеёиоуыэюя]+$/);
        if (pivot > 0) {
          parts.push(current.slice(0, pivot));
          current = current.slice(pivot);
        }
      }
      current += letter;
      parts.push(current);
      current = '';
    } else {
      current += letter;
    }
  }
  if (current) {
    if (parts.length) parts[parts.length - 1] += current;
    else parts.push(current);
  }
  return parts.length ? parts : [word];
}

function ruWord(word: string): { roman: string; zh: string } {
  const lower = word.toLowerCase();
  let roman = '';
  let zh = '';
  let index = 0;
  while (index < lower.length) {
    // Prefer the CV reading (при → 里) over per-letter guesses.
    const pair = RU_CV[lower.slice(index, index + 2)];
    if (pair) {
      roman += pair[0];
      zh += pair[1];
      index += 2;
      continue;
    }
    const letter = lower[index];
    const entry = RU_MAP[letter];
    if (entry) {
      roman += entry[0];
      zh += entry[1];
    } else {
      roman += letter;
      zh += letter;
    }
    index += 1;
  }
  return { roman, zh };
}

// ------------------------------------------------------------------ Japanese

/*
 * 日语全部交给 pronunciation-ja.ts。
 *
 * 这里曾经有一份 40 行的「假名表 + 汉字表」，四个错误全在里面：
 * `toHiragana` 只转换第一个字符（`カメラ → kara`）、促音不吞长音
 * （`ガッコウ → gako`）、长音判断恒为真（`コーヒー → kohi`）、
 * 未知汉字原样输出（`空港 → 空港`）。现在只保留一个入口。
 */
export { readJapanese, jaChunks, toHiraganaText, toKatakanaText } from './pronunciation-ja';
export type { JaReading, JaUnit } from './pronunciation-ja';

// ------------------------------------------------------------------ Korean

const KO_INITIAL = [
  ['g', 'ㄱ'], ['kk', 'ㄲ'], ['n', 'ㄴ'], ['d', 'ㄷ'], ['tt', 'ㄸ'], ['r', 'ㄹ'],
  ['m', 'ㅁ'], ['b', 'ㅂ'], ['pp', 'ㅃ'], ['s', 'ㅅ'], ['ss', 'ㅆ'], ['', 'ㅇ'],
  ['j', 'ㅈ'], ['jj', 'ㅉ'], ['ch', 'ㅊ'], ['k', 'ㅋ'], ['t', 'ㅌ'], ['p', 'ㅍ'],
  ['h', 'ㅎ'],
];
const KO_INITIAL_ZH = ['格', '格', '恩', '德', '德', '尔', '姆', '波', '波', '斯', '斯', '', '兹', '兹', '奇', '克', '特', '坡', '赫'];
const KO_MEDIAL: [string, string][] = [
  ['a', '阿'], ['ae', '艾'], ['ya', '亚'], ['yae', '艾'], ['eo', '奥'], ['e', '艾'],
  ['yeo', '约'], ['ye', '耶'], ['o', '奥'], ['wa', '哇'], ['wae', '外'], ['oe', '维'],
  ['yo', '约'], ['u', '乌'], ['weo', '沃'], ['we', '韦'], ['wi', '威'], ['yu', '尤'],
  ['eu', '厄'], ['yi', '伊'], ['i', '伊'],
];
const KO_FINAL: [string, string][] = [
  ['', ''], ['k', '克'], ['k', '克'], ['k', '克'], ['n', '恩'], ['n', '恩'], ['n', '恩'],
  ['t', '特'], ['l', '尔'], ['k', '克'], ['m', '姆'], ['p', '普'], ['l', '尔'],
  ['l', '尔'], ['l', '尔'], ['p', '普'], ['l', '尔'], ['m', '姆'], ['p', '普'],
  ['p', '普'], ['t', '特'], ['t', '特'], ['ng', '英'], ['t', '特'], ['t', '特'],
  ['k', '克'], ['t', '特'], ['p', '普'], ['t', '特'],
];

/** When a 받침 is followed by a vowel-initial syllable it moves over: 냈+어 → 내+써 */
const KO_FINAL_TO_INITIAL = [
  0, 0, 1, 9, 2, 2, 2, 3, 5, 15, 6, 7, 9, 16, 17, 18, 6, 7, 7, 9, 10, 11, 12, 14, 15, 16, 17, 18,
];
/** Consonant that stays behind when a cluster-final splits (ㄺ → ㄹ + ㄱ). */
const KO_FINAL_KEEP = {
  3: 1, 9: 8, 10: 8, 11: 8, 12: 8, 13: 8, 14: 8, 15: 8, 18: 17,
} as Record<number, number>;

interface KoSyllable {
  initial: number;
  medial: number;
  final: number;
}

function koParse(letter: string): KoSyllable | null {
  const code = letter.codePointAt(0) ?? 0;
  if (code < 0xac00 || code > 0xd7a3) return null;
  const offset = code - 0xac00;
  return {
    initial: Math.floor(offset / (21 * 28)),
    medial: Math.floor((offset % (21 * 28)) / 28),
    final: offset % 28,
  };
}

function koCompose(parts: KoSyllable): string {
  return String.fromCodePoint(0xac00 + parts.initial * 21 * 28 + parts.medial * 28 + parts.final);
}

function koWord(word: string): { roman: string; zh: string } {
  // Split into syllables, then resyllabify where a 받침 meets a vowel.
  const syllables: (KoSyllable | null)[] = [...word].map(koParse);
  for (let i = 0; i < syllables.length - 1; i += 1) {
    const current = syllables[i];
    const next = syllables[i + 1];
    if (!current || !next || current.final === 0 || next.initial !== 11) continue;
    const moved = KO_FINAL_TO_INITIAL[current.final] ?? 0;
    const keep = KO_FINAL_KEEP[current.final] ?? 0;
    syllables[i] = { ...current, final: keep };
    syllables[i + 1] = { ...next, initial: moved };
  }

  const letters = [...word];
  let roman = '';
  let zh = '';
  for (let i = 0; i < letters.length; i += 1) {
    const syllable = syllables[i];
    if (!syllable) {
      // Punctuation / latin characters pass straight through.
      roman += letters[i];
      zh += letters[i];
      continue;
    }
    const [initialLatin] = KO_INITIAL[syllable.initial] ?? [''];
    const [medialLatin, medialZh] = KO_MEDIAL[syllable.medial] ?? [''];
    const [finalLatin, finalZh] = KO_FINAL[syllable.final] ?? [''];
    // Syllables inside a word are written together: 오랜만이야, not o raen man i ya.
    roman += `${initialLatin}${medialLatin}${finalLatin}`;
    zh += `${KO_INITIAL_ZH[syllable.initial] ?? ''}${medialZh}${finalZh}`;
  }
  return { roman, zh };
}

function koSyllables(text: string): string[] {
  const letters = [...text].filter((letter) => koParse(letter) !== null);
  // Re-compose after resyllabification so the display matches the romanization.
  const word = letters.join('');
  const parsed: (KoSyllable | null)[] = [...word].map(koParse);
  for (let i = 0; i < parsed.length - 1; i += 1) {
    const current = parsed[i];
    const next = parsed[i + 1];
    if (!current || !next || current.final === 0 || next.initial !== 11) continue;
    const moved = KO_FINAL_TO_INITIAL[current.final] ?? 0;
    const keep = KO_FINAL_KEEP[current.final] ?? 0;
    parsed[i] = { ...current, final: keep };
    parsed[i + 1] = { ...next, initial: moved };
  }
  return parsed.filter(Boolean).map((part) => koCompose(part as KoSyllable));
}

// ------------------------------------------------------------------ dispatch

export function splitSyllables(text: string, language: TargetLanguage = 'English'): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const word of words) {
    if (language === 'Japanese') out.push(jaChunks(word).join('-'));
    else if (language === 'Korean') out.push(koSyllables(word).join('-'));
    else if (language === 'Russian') out.push(ruSyllables(word).join('-'));
    else out.push(syllablesOfWord(word).join('-'));
  }
  return out;
}

/**
 * 逐词音译缓存。
 *
 * 字幕区每次刷新都会对**所有**字幕重算中文谐音，而识别是逐词推进的 ——
 * 一句话每多一个词就会再触发一次全量重算。整句音译是「逐词查表 + 规则推导」，
 * 不做缓存时，字幕一多就会明显拖慢渲染。词级缓存把最贵的一层挡掉：
 * 同一个词在进程生命周期内只算一次。
 *
 * 上限存在的意义是防内存泄漏：真的有 4000 个不同的词时直接清空重来，
 * 比无限增长安全。
 */
const WORD_CACHE = new Map<string, string>();
const WORD_CACHE_LIMIT = 4000;

export function transliterateWord(word: string, language: TargetLanguage = 'English'): string {
  const key = `${language}\u0000${word}`;
  const cached = WORD_CACHE.get(key);
  if (cached !== undefined) return cached;
  const value = computeWordSound(word, language);
  if (WORD_CACHE.size >= WORD_CACHE_LIMIT) WORD_CACHE.clear();
  WORD_CACHE.set(key, value);
  return value;
}

function computeWordSound(word: string, language: TargetLanguage): string {
  if (language === 'Russian') return ruWord(word).zh;
  if (language === 'Japanese') {
    /*
     * 汉字查不到读音时**不返回汉字本身**。
     *
     * 以前 `空港 → 空港`：界面上那一行看起来像读音，实际上一个音都没给，
     * 用户照着念只会念出中文。现在返回空串，界面显示「读音未确定」，
     * 比一行假读音诚实得多。
     */
    const reading = readJapanese(word);
    return reading.unknown.length ? '' : reading.zh;
  }
  if (language === 'Korean') return koWord(word).zh;
  return enTransliterateWord(word);
}

/** 整句谐音缓存：字幕区的调用是「同一句话反复问」，句子级缓存命中率最高。 */
const TEXT_CACHE = new Map<string, string>();
const TEXT_CACHE_LIMIT = 2000;

export function transliterate(text: string, language: TargetLanguage = 'English'): string {
  const key = `${language}\u0000${text}`;
  const cached = TEXT_CACHE.get(key);
  if (cached !== undefined) return cached;

  const joiner = language === 'Japanese' || language === 'Korean' ? '' : ' ';
  const value = text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => transliterateWord(word, language))
    .join(joiner);

  if (TEXT_CACHE.size >= TEXT_CACHE_LIMIT) TEXT_CACHE.clear();
  TEXT_CACHE.set(key, value);
  return value;
}

/** Latin romanization for non-Latin scripts; empty for English. */
export function romanize(text: string, language: TargetLanguage = 'English'): string {
  if (language === 'Russian') {
    return text.split(/\s+/).filter(Boolean).map((w) => ruWord(w).roman).join(' ');
  }
  if (language === 'Japanese') {
    // 日语没有空格分词，所以交给词典 + 音拍解析整段读，再按空格还原用户的分隔。
    return text
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => readJapanese(w).roman)
      .join(' ');
  }
  if (language === 'Korean') {
    return text.split(/\s+/).filter(Boolean).map((w) => koWord(w).roman).join(' ');
  }
  return '';
}

/** 去掉空白和标点，用来比较两个字符串是不是「同一句话」。 */
function bare(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/**
 * 模型给的 ipa 能不能信。
 *
 * 7B 级别的模型在 "ipa" 这个字段上失败得非常一致，实测（Qwen2.5-7B，四组真实
 * 请求共 12 条）有 7 条是垃圾，分三类：
 *   1. **写成中文拼音** —— `zhēn yīnáng xiǎn zhe tóng yīng…` / `nɑ ɛr ɦǎo ah`。
 *      模型把 "IPA" 理解成了「给中文注音」，实测占比最高。
 *   2. **直接抄英文原文** —— `i am good how about you`。
 *   3. **编一串没有音系意义的符号** —— `njuː mə ʔen æt ʔɛn ə ʃvət`（对不上原句）。
 *
 * 卡片上宁可少一行，也绝不能给用户一行错的音标让他照着念 —— 提示词里本来就
 * 写明「不确定就返回空字符串」，所以这里判定「不可信」就整个丢掉。
 */
export function ipaLooksWrong(ipa: string | undefined, english: string): boolean {
  const value = (ipa ?? '').trim();
  // 空值是合法的（提示词允许），不算「错」，交给卡片自己隐藏那一行。
  if (!value) return false;

  // 只接受「拉丁字母 + IPA 符号」。实测模型会往这一栏塞完全不相干的文字：
  // 天城文 `kəˈmɪtमnt`、希腊字母 `keɪmɪνteɪ`。汉字与注音符号同样落在白名单外。
  if (/[^\x20-\x7E\u00C0-\u024F\u0250-\u02FF\u0300-\u036F]/.test(value)) return true;

  // 拼音声调符号（āáǎà…）→ 是拼音，不是音标。
  // 必须单独判：它们落在拉丁扩展区里，白名单拦不住；而拼音里的 ɑ / ɛ / ɦ
  // 恰好也是 IPA 字母，光看字符集同样会漏。
  if (/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(value)) return true;

  const bareIpa = bare(value);
  const bareEnglish = bare(english);
  if (!bareIpa) return true;

  // 抄了原文（标点无关）。
  if (bareIpa === bareEnglish) return true;

  // 长度明显不够覆盖整句。
  if (bareEnglish.length >= 6 && bareIpa.length < bareEnglish.length * 0.5) return true;

  // 一个 IPA 专属字符都没有 → 不是音标。
  // 英语宽式音标几乎必然出现 ə / ɪ / ʊ / æ / ʃ / θ / ð / ŋ 中的至少一个；
  // 纯 ASCII 的「音标」实际上都是拼写或拼音。
  if (!/[əɪʊæɑɔʌʃʒθðŋɹɜɒɛɐˈˌ]/.test(value)) return true;

  return false;
}

/**
 * 模型给的分块能不能信。
 *
 * 与 ipa 同样是实测出来的三类脏数据：
 *   1. **写成中文译文** —— `['真 难 以 想 象','同 一 个','狼 群']`（看视频场景）；
 *   2. **混进了音标** —— `['I ˈtəʊtəl əˈɡri:','i ˈti:θvɪz']`，和 ipa 字段串了；
 *   3. **整句重复了一遍** —— `['Have','you',…,'parts','have','you',…,'parts','I',…]`。
 *
 * 判据里最有用的是「拼回去必须等于原句」：分块本质上是把同一句话切开，
 * 复制、丢词、写中文都会让拼接结果对不上。
 */
export function syllablesLookWrong(
  syllables: string[] | undefined,
  english: string,
): boolean {
  if (!syllables?.length) return false; // 空 → 交给本地引擎补，不算错

  const chunks = syllables.map((chunk) => String(chunk).trim()).filter(Boolean);
  if (!chunks.length) return true;

  // 1. 中文 / 假名 / 谚文 / 西里尔 → 是译文，不是分块。
  if (chunks.some((chunk) => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(chunk))) {
    return true;
  }

  // 2. 混进了音标（模型把两个字段串了）。
  if (chunks.some((chunk) => /[əɪʊæɑɔʌʃʒθðŋɹɜɒɛˈˌ]/.test(chunk))) return true;

  // 3. 出现「纯标点」或「以标点开头」的块 —— 实测模型会给出
  //    `[…,'it','.','Do',…]` / `['Rea-lly','? Me too',…]` 这种切法，
  //    显示成 `it · . · Do` 完全没法读。判定不可信，交给本地引擎重切。
  if (chunks.some((chunk) => /^[^\p{L}\p{N}]+$/u.test(chunk))) return true;
  if (chunks.some((chunk) => /^[^\p{L}\p{N}]/u.test(chunk))) return true;

  // 4. 拼不回原句 → 复制或丢词了。
  const joined = bare(chunks.join(''));
  const target = bare(english);
  if (target && joined !== target) return true;

  return false;
}

/**
 * 中文翻译里不该出现「逐字空格」。
 *
 * from-chinese 模式下 7B 模型经常把译文写成
 *     `真 的 呢 ， 同 样 我 也 爱 看 这 个 节 目`
 * 卡片上看起来跟「逐字注音」一模一样，用户会以为整张卡都是坏的（实测两次
 * 真实运行都复现了）。这里只吃掉「中文 / 中文标点之间」的空格；英文单词之间
 * 的空格原样保留 —— "发个 email 给我" 里的空格是有意义的。
 */
export function tidyChinese(text: string): string {
  const value = (text ?? '').trim();
  if (!value) return value;
  const cjk = '[\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]';
  const pattern = new RegExp(`(${cjk})[ \\t]+(?=${cjk})`, 'g');
  let out = value;
  // 一次 replace 不会处理重叠的部分（`真 的 呢` 只吃掉第一个空格），循环到稳定。
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(pattern, '$1');
    if (next === out) break;
    out = next;
  }
  return out;
}

// ------------------------------------------------------- 提示与原句的绑定

/**
 * 提示算法的版本号。
 *
 * 缓存键、历史记录里都要带上它：同一句话换了算法（比如 0.6.0 重写了日语）
 * 之后，旧结果必须失效重算，否则用户会看到一份用旧规则算出来的读音，
 * 而界面以为它是新的。
 */
export const HINT_VERSION = 2;

/** 一个「原文片段 + 对应读音提示」。 */
export interface HintSegment {
  /** 稳定 ID：用原文范围表示，原文一改就自然失效。 */
  id: string;
  /** 在原文里的起止位置（UTF-16，含头不含尾）。 */
  from: number;
  to: number;
  /** 原文片段（surface），界面上点它就能定位。 */
  source: string;
  /** 给使用者看的近音（字系由 system 决定）。 */
  hint: string;
  /** 拉丁转写（日语罗马字等），没有就是 undefined。 */
  roman?: string;
  /**
   * 这一段的读音可信到什么程度：
   *  - `ok`：词典查到的（日语假名/词表、英语高频词表）；
   *  - `approx`：本地规则拼出来的（词典没有的人名、缩写、片假名转写）——
   *    能用来试着念，但不能当成核对过的读音；
   *  - `unknown`：连近似都给不出（未收录的汉字），提示为空。
   */
  status: 'ok' | 'approx' | 'unknown';
  /**
   * 这行读音是哪来的：
   *  - `rule`：本地规则/词典算出来的（近似，不是母语者核对过的）；
   *  - `manual`：用户自己在个人词表里填的。
   * 界面必须分开说 —— 用户填的不能冒充「已核对」。
   */
  origin?: 'rule' | 'manual';
}

export interface HintPlan {
  system: HintSystem;
  target: TargetLanguage;
  /** 拼好的整行提示文本（界面上显示这一行）。 */
  text: string;
  /** 整句罗马字（日语/俄语/韩语有，英语没有）。 */
  roman: string;
  segments: HintSegment[];
  /** 没能确定读音的片段（原样汉字等）。 */
  unknown: string[];
  /** 规则拼出来的片段数（能念，但未核对）。 */
  approximate: number;
  /**
   * ok = 全部来自词典；approx = 有规则近似但没有未确定；
   * partial = 有片段完全未确定；unsupported = 这个组合本版没有提示。
   */
  status: 'ok' | 'approx' | 'partial' | 'unsupported';
  version: number;
}

const EMPTY_PLAN = (system: HintSystem, target: TargetLanguage): HintPlan => ({
  system,
  target,
  text: '',
  roman: '',
  segments: [],
  unknown: [],
  approximate: 0,
  status: 'unsupported',
  version: HINT_VERSION,
});

/** 界面上要断词的字符集合。 */
interface WordSpan {
  from: number;
  to: number;
  text: string;
}

/**
 * 按**真实词边界**切分，而不是按空格。
 *
 * 日语、中文没有空格 —— 拿 `split(' ')` 去切会得到「一整句」，点词看读音
 * 就永远点不到具体的词。`Intl.Segmenter` 在 Electron 33（Chromium 130）
 * 里是可用的，日语/中文都有词典级分词；环境不支持时退回正则，
 * 至少英文还能逐词。
 */
export function wordSpans(text: string, language: TargetLanguage): WordSpan[] {
  const raw = String(text ?? '');
  if (!raw) return [];
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => {
    segment: (input: string) => Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
  } }).Segmenter;

  if (typeof Segmenter === 'function') {
    try {
      const segmenter = new Segmenter(undefined, { granularity: 'word' });
      const out: WordSpan[] = [];
      for (const part of segmenter.segment(raw)) {
        if (!part.isWordLike) continue;
        out.push({ from: part.index, to: part.index + part.segment.length, text: part.segment });
      }
      if (out.length) return out;
    } catch {
      // 落到下面的正则兜底
    }
  }

  const pattern =
    language === 'English'
      ? /[A-Za-z][A-Za-z'’-]*/g
      : /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]+/g;
  const out: WordSpan[] = [];
  for (const match of raw.matchAll(pattern)) {
    out.push({ from: match.index ?? 0, to: (match.index ?? 0) + match[0].length, text: match[0] });
  }
  return out;
}

/**
 * 把被分词器切开的带点缩写合回一段（`p` + `.` + `m` → `p.m`）。
 *
 * Chromium 的 ICU 与 Node 的 ICU 行为不一致：Node 把 `p.m.` 当一个词，
 * Electron 里切成 `p` 和 `m` 两个词，于是缩写表命不中、退回逐字母拼读，
 * 界面上就是「普 姆」而不是「皮艾姆」。合并后再查表就能对上。
 *
 * 只合「字母 + 点 + 字母」这种形状，句子里的句号不会被误合
 * （"…tomorrow. Next" 中间是空格，不是点）。
 */
function mergeDottedSpans(text: string, spans: WordSpan[]): WordSpan[] {
  const out: WordSpan[] = [];
  for (const span of spans) {
    const prev = out[out.length - 1];
    const gap = prev ? text.slice(prev.to, span.from) : '';
    const letterRun = prev && /^[A-Za-z]{1,3}$/.test(prev.text) && /^[A-Za-z]{1,3}$/.test(span.text);
    if (prev && letterRun && gap === '.') {
      out[out.length - 1] = { from: prev.from, to: span.to, text: text.slice(prev.from, span.to) };
      continue;
    }
    out.push({ ...span });
  }
  return out;
}

/** 一个词在指定提示体系下的读法。 */
function readWord(
  word: string,
  target: TargetLanguage,
  system: HintSystem,
): { hint: string; roman?: string; unknown: boolean; approx?: boolean } {
  if (system === 'none' || !word.trim()) return { hint: '', unknown: true };

  /*
   * 纯数字 / 符号原样留着。
   *
   * 「3 p.m.」里的 3 是一段字，不是一个词 —— 之前它被当成「未确定读音」，
   * 于是整句提示被标成「部分未核对」，用户看到一条黄色警告只为提醒他
   * 那里有个数字。数字本来就该照原样读。
   */
  if (!/[A-Za-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(word)) {
    return { hint: word, unknown: false };
  }

  if (target === 'Japanese') {
    const reading = readJapanese(word);
    const unknown = reading.unknown.length > 0;
    if (system === 'romaji') return { hint: reading.roman, roman: reading.roman, unknown };
    if (system === 'katakana') return { hint: reading.katakana, roman: reading.roman, unknown };
    return { hint: reading.zh, roman: reading.roman, unknown };
  }

  if (target === 'English') {
    // 片假名体系对英语没有词典，只能是规则转写 —— 一律标近似。
    if (system === 'katakana') return { hint: enToKatakana(word), unknown: false, approx: true };
    if (system === 'hanzi') {
      /*
       * 单个字母（`p` / `m` / `A`）：英语里几乎都是字母名本身，不是音节。
       *
       * Chromium 的 ICU 会把 `p.m.` 切成 `p` 和 `m` 两段（Node 那边切成一段），
       * 一旦落到规则拼读就成了「普」「姆」—— 0.6.1 界面自检里就是这么暴露的。
       */
      if (/^[A-Za-z]$/.test(word)) {
        return { hint: LETTER_SOUNDS[word.toLowerCase()] ?? word, unknown: false, approx: true };
      }
      const abbrev = readEnglishAbbreviation(word);
      if (abbrev) return { hint: abbrev.hint, unknown: false, approx: abbrev.approx };
      const clean = word.toLowerCase().replace(/[^a-z]/g, '');
      const dict = clean ? knownSound(clean) : undefined;
      // 词典命中：这是查出来的读法，不是拼出来的。
      if (dict) return { hint: dict, unknown: false };
      /*
       * 词典没收录的词（人名 Okafor、地名、生僻词）走规则拼读。
       * 规则拼读一定不准确 —— 以前它和词典命中的词一样标成「确定」，
       * 等于把猜的当成查到的。现在带 approx 标记，界面上要看得出区别。
       */
      return { hint: transliterateWord(word, 'English'), unknown: false, approx: true };
    }
    // 英语本身就是拉丁字母，罗马字提示没有意义。
    return { hint: '', unknown: true };
  }

  // 俄语 / 韩语：本版只提供汉字近音与拉丁转写。
  if (system === 'hanzi') return { hint: transliterateWord(word, target), unknown: false, approx: true };
  if (system === 'romaji') {
    const roman = romanize(word, target);
    return { hint: roman, roman, unknown: !roman, approx: true };
  }
  return { hint: '', unknown: true };
}

/**
 * 为目标语言的原文生成提示。
 *
 * **输入永远是「最终要展示给用户的那句原文」**，输出一定与它逐词对齐：
 * 每个片段都带原文范围，原文被改写之后这些 ID 就对不上、必须重算。
 * 这样「こんにちは」就再也配不上 "banana" 了 —— 不是靠校验文本像不像，
 * 而是提示本来就是从这句话算出来的。
 */
export function buildHintPlan(
  source: string,
  target: TargetLanguage,
  system: HintSystem,
  /**
   * 个人词表。命中时**优先于**规则引擎 —— 用户自己填的读音比规则更可信，
   * 但只在同一种提示体系下生效（汉字近音和片假名是两套写法）。
   */
  custom?: CustomReading[],
): HintPlan {
  const text = String(source ?? '');
  if (!text.trim() || system === 'none') return EMPTY_PLAN(system, target);

  const rawSpans = wordSpans(text, target);
  // 英译时的带点缩写（p.m. / U.S.）要先合回一段再查表。
  const spans = target === 'English' ? mergeDottedSpans(text, rawSpans) : rawSpans;
  const segments: HintSegment[] = [];
  const unknown: string[] = [];

  for (const span of spans) {
    const customHit = findCustomReading(span.text, system, custom);
    if (customHit) {
      segments.push({
        id: `${span.from}-${span.to}`,
        from: span.from,
        to: span.to,
        source: span.text,
        hint: customHit.reading,
        status: 'ok',
        origin: 'manual',
      });
      continue;
    }
    const reading = readWord(span.text, target, system);
    const ok = !reading.unknown && Boolean(reading.hint);
    if (!ok) unknown.push(span.text);
    segments.push({
      id: `${span.from}-${span.to}`,
      from: span.from,
      to: span.to,
      source: span.text,
      hint: ok ? reading.hint : '',
      roman: reading.roman || undefined,
      status: !ok ? 'unknown' : reading.approx ? 'approx' : 'ok',
      origin: 'rule',
    });
  }

  if (!segments.length) return EMPTY_PLAN(system, target);

  /*
   * 日语词之间要不要空格，取决于是哪种提示体系。
   *
   * 汉字近音和片假名是一串音节，连写更像日语原文；罗马字是全拉丁的，
   * 不加空格就成了 "mouichidoonegaishimasu" 一整串，读的人没法断词 ——
   * 而这行提示存在的意义正是帮他断词念出来。
   */
  const joiner = target === 'Japanese' && system !== 'romaji' ? '' : ' ';
  const text2 = segments
    .filter((segment) => segment.hint)
    .map((segment) => segment.hint)
    .join(joiner);

  const approximate = segments.filter((segment) => segment.status === 'approx').length;

  if (!text2) return { ...EMPTY_PLAN(system, target), segments, unknown, approximate, status: 'partial' };

  return {
    system,
    target,
    text: text2,
    roman: segments
      .map((segment) => segment.roman ?? '')
      .filter(Boolean)
      .join(' '),
    segments,
    unknown,
    approximate,
    status: unknown.length ? 'partial' : approximate ? 'approx' : 'ok',
    version: HINT_VERSION,
  };
}

/** 去掉空白 / 分隔符，用来做字符级比对。 */
function squash(text: string): string {
  return text.replace(/[\s・·\-–—'’.。、，,!?！？]/g, '').toLowerCase();
}

/** 二元组重合率，用来判断两串读音是不是在说同一句话。 */
function bigramOverlap(a: string, b: string): number {
  const left = squash(a);
  const right = squash(b);
  if (!left || !right) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let hit = 0;
  let total = 0;
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    total += 1;
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      hit += 1;
      grams.set(gram, count - 1);
    }
  }
  return total ? hit / total : 0;
}

/**
 * 模型给的一行提示，能不能信。
 *
 * 0.5.0 只检查「有没有汉字、有没有拉丁字母」，于是
 * 「こんにちは → banana」这种**字系正确、内容无关**的结果被原样保留了。
 * 现在除了字系，还要和「本地按同一句原文算出来的读法」比字符重合度：
 * 差得太远就判定为无关，宁可空着。
 *
 * 注意这不是「准确率」——它只能证明两串读音在描述同一段声音，
 * 不能证明发音标准。界面上也不做任何准确率声明。
 */
export function hintLooksWrong(
  hint: string | undefined,
  source: string,
  target: TargetLanguage,
  system: HintSystem,
): boolean {
  const value = String(hint ?? '').trim();
  if (!value) return true;
  if (system === 'none') return false;

  const expected = buildHintPlan(source, target, system);
  const chunks = value.split(/\s+/).filter(Boolean);

  if (system === 'katakana') {
    // 片假名提示里只能有片假名、长音符、中点。
    if (/[^\u30a1-\u30fa\u30fc\u30fb\s]/.test(value)) return true;
  } else if (system === 'romaji') {
    if (/[^A-Za-z\s'’-]/.test(value)) return true;
  } else if (system === 'hanzi') {
    if (!/[\u4e00-\u9fff]/.test(value)) return true;
    if (/[A-Za-z]{2,}/.test(value)) return true;
    if (/[\u3040-\u30ff]/.test(value)) return true;
  }

  // 逐块对齐的提示，块数应该和词数同量级；差太多说明它不是一个词一块。
  if (target === 'English' && expected.segments.length >= 3) {
    if (chunks.length < Math.max(2, Math.ceil(expected.segments.length / 2))) return true;
  }

  if (!expected.text) return false;

  // 与本地读法的字符重合度太低 → 不是这段话的读音。
  const similarity = bigramOverlap(value, expected.text);
  if (similarity < 0.25) return true;

  return false;
}

/** 兼容旧名字：只判汉字近音。 */
export function chinesePronLooksWrong(
  pronunciation: string | undefined,
  draft: { english: string; chinese: string },
): boolean {
  const value = (pronunciation ?? '').trim();
  if (!value) return true;
  if (!/[\u4e00-\u9fff]/.test(value)) return true;
  if (/[əɪʊæɑɔʌʃʒθðŋɹɜɒɛɡˈˌː]/.test(value)) return true;
  if (/[A-Za-z]{2,}/.test(value)) return true;
  if (/[，。！？、；：""''（）《》〈〉【】…,.;:!?]/.test(value)) return true;
  const bareValue = bare(value);
  if (!bareValue) return true;
  if (bareValue === bare(draft.chinese)) return true;
  const words = draft.english.split(/\s+/).filter(Boolean).length;
  if (words >= 3) {
    const groups = value.split(/\s+/).filter(Boolean).length;
    if (groups < Math.max(2, Math.ceil(words / 2))) return true;
  }
  if (hintLooksWrong(value, draft.english, 'English', 'hanzi')) return true;
  return false;
}

/**
 * 补全一条草稿里缺的读音数据。
 *
 * `hintSystem` 决定「给谁看」：中文读者看汉字近音，日语读者看片假名，
 * 英语读者看罗马字。同一个英文句子，两边拿到的提示不该一样 ——
 * 缓存里也必须用 system 区分，否则切换语言会串。
 */
export function enrichDraft(
  draft: {
    kind: 'simple' | 'natural' | 'continue';
    english: string;
    chinese: string;
    meaning?: string;
    ipa?: string;
    syllables?: string[];
    chinesePronunciation?: string;
    romanization?: string;
    readingHint?: string;
  },
  language: TargetLanguage = 'English',
  hintSystem: HintSystem = 'hanzi',
) {
  const english = String(draft.english ?? '').trim();
  const ipa = (draft.ipa ?? '').trim();
  const chinese = tidyChinese(draft.meaning ?? draft.chinese ?? '');
  // 分块只有「模型给了、且拼得回原句」才用它；空数组同样要走本地引擎 ——
  // 少一个字段就用 undefined 顶上，会让卡片「分块」那一行直接消失。
  const chunks = Array.isArray(draft.syllables) ? draft.syllables : [];
  const keepChunks = chunks.length > 0 && !syllablesLookWrong(chunks, english);
  const tidy = { ...draft, english, chinese };

  // 提示永远以「这句原文」为输入重算，模型给的只在通过校验时才采用。
  const plan = buildHintPlan(english, language, hintSystem);
  const modelHint = (draft.readingHint ?? draft.chinesePronunciation ?? '').trim();
  const usePlan = !modelHint || hintLooksWrong(modelHint, english, language, hintSystem);
  const readingHint = !english ? '' : usePlan ? plan.text : modelHint;
  /*
   * 类型要显式写：这里的返回值会被直接当成 ReplyDraft 用，
   * 交给 TS 推断会把字面量联扩成 string，调用方就赋不进去了。
   */
  const hintStatus: 'ok' | 'approx' | 'partial' | 'none' =
    !english || plan.status === 'unsupported'
      ? 'none'
      : plan.status === 'partial'
        ? 'partial'
        : plan.status === 'approx'
          ? 'approx'
          : 'ok';

  return {
    ...tidy,
    meaning: chinese,
    // 模型给的音标不可信时直接不要 —— 空白比一行错的音标安全得多。
    ipa: ipa && !ipaLooksWrong(ipa, english) ? ipa : undefined,
    // english 意外缺失时（脏 JSON 里出现过裸 {}）不能让整条回复崩掉。
    syllables: english ? (keepChunks ? chunks : splitSyllables(english, language)) : [],
    readingHint,
    hintSystem,
    hintStatus,
    hintVersion: HINT_VERSION,
    // 旧字段：中文读者仍然从 chinesePronunciation 读，保持历史与界面兼容。
    chinesePronunciation: hintSystem === 'hanzi' ? readingHint : undefined,
    romanization:
      // 英语没有「罗马音」这回事 —— 卡片上那一行会原样渲染。模型偶尔会往这个
      // 字段里塞中文拼音（实测 `tài bàng le wǒ yě shì zài dāi yǒu nǐ yě`），
      // 所以英语时无条件丢掉；其它语言才用本地算出来的。
      language === 'English' ? undefined : plan.roman || romanize(english, language),
  };
}

export function enrichDrafts<
  T extends {
    kind: 'simple' | 'natural' | 'continue';
    english: string;
    chinese: string;
    meaning?: string;
    ipa?: string;
    syllables?: string[];
    chinesePronunciation?: string;
    romanization?: string;
    readingHint?: string;
  },
>(drafts: T[], language: TargetLanguage = 'English', hintSystem: HintSystem = 'hanzi') {
  return drafts.map((draft) => enrichDraft(draft, language, hintSystem));
}
