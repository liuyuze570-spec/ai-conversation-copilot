/**
 * 英语 → 片假名近似音。
 *
 * 给「熟悉日语、想说英语」的人用：日本人读英语外来词时的习惯标注就是片假名，
 * 一个假名一个拍子，念出来虽然带腔，但**能开口**——这正是听障使用者需要的。
 *
 * 必须说清楚的边界：
 *   · 这是**按拼写规则做的近似**，不是音标转写。英语的拼写和读音对不上
 *     （through / though / tough），规则表只能覆盖常见组合。
 *   · 与汉字近音一样，这里不声称「照着念就准」。界面上标「近似」。
 *   · 表只覆盖本软件实际会遇到的组合，没有为了「支持更多语言」去堆无关字符表。
 */

/** 辅音 + 元音 → 片假名（与汉字近音共用一套切分思路：按音节对，不按字母猜）。 */
const CV: Record<string, string> = {
  ba: 'バ', be: 'ベ', bi: 'ビ', bo: 'ボ', bu: 'ブ', by: 'バイ',
  ca: 'カ', ce: 'セ', ci: 'シ', co: 'コ', cu: 'ク', cy: 'サイ',
  da: 'ダ', de: 'デ', di: 'ディ', do: 'ド', du: 'ドゥ', dy: 'ダイ',
  fa: 'ファ', fe: 'フェ', fi: 'フィ', fo: 'フォ', fu: 'フ', fy: 'ファイ',
  ga: 'ガ', ge: 'ゲ', gi: 'ギ', go: 'ゴ', gu: 'グ', gy: 'ギ',
  ha: 'ハ', he: 'ヘ', hi: 'ヒ', ho: 'ホ', hu: 'フ', hy: 'ハイ',
  ja: 'ジャ', je: 'ジェ', ji: 'ジ', jo: 'ジョ', ju: 'ジュ', jy: 'ジェ',
  ka: 'カ', ke: 'ケ', ki: 'キ', ko: 'コ', ku: 'ク', ky: 'ケイ',
  la: 'ラ', le: 'レ', li: 'リ', lo: 'ロ', lu: 'ル', ly: 'ライ',
  ma: 'マ', me: 'メ', mi: 'ミ', mo: 'モ', mu: 'ム', my: 'マイ',
  na: 'ナ', ne: 'ネ', ni: 'ニ', no: 'ノ', nu: 'ヌ', ny: 'ナイ',
  pa: 'パ', pe: 'ペ', pi: 'ピ', po: 'ポ', pu: 'プ', py: 'パイ',
  ra: 'ラ', re: 'レ', ri: 'リ', ro: 'ロ', ru: 'ル', ry: 'ライ',
  sa: 'サ', se: 'セ', si: 'シ', so: 'ソ', su: 'ス', sy: 'サイ',
  ta: 'タ', te: 'テ', ti: 'ティ', to: 'ト', tu: 'トゥ', ty: 'タイ',
  va: 'ヴァ', ve: 'ヴェ', vi: 'ヴィ', vo: 'ヴォ', vu: 'ヴ', vy: 'ヴァイ',
  wa: 'ワ', we: 'ウェ', wi: 'ウィ', wo: 'ウォ', wu: 'ウ', wy: 'ワイ',
  za: 'ザ', ze: 'ゼ', zi: 'ジ', zo: 'ゾ', zu: 'ズ', zy: 'ザイ',
  ya: 'ヤ', ye: 'イェ', yi: 'イ', yo: 'ヨ', yu: 'ユ',
  xa: 'クサ', xe: 'クセ', xi: 'クシ', xo: 'クソ', xu: 'クス',
  qua: 'クワ', que: 'クエ', qui: 'クイ', quo: 'クオ',
  cha: 'チャ', che: 'チェ', chi: 'チ', cho: 'チョ', chu: 'チュ',
  sha: 'シャ', she: 'シェ', shi: 'シ', sho: 'ショ', shu: 'シュ',
  tha: 'サ', the: 'ザ', thi: 'シ', tho: 'ソ', thu: 'ス', thy: 'サイ',
  pha: 'ファ', phe: 'フェ', phi: 'フィ', pho: 'フォ', phu: 'フ',
  wha: 'ワ', whe: 'ウェ', whi: 'ウィ', who: 'フ',
  kna: 'ナ', kne: 'ネ', kni: 'ニ', kno: 'ノ', knu: 'ニュ',
  tra: 'トラ', tre: 'トレ', tri: 'トリ', tro: 'トロ', tru: 'トゥル', try: 'トライ',
  dra: 'ドラ', dre: 'ドレ', dri: 'ドリ', dro: 'ドロ', dru: 'ドゥル', dry: 'ドライ',
};

/** 元音组合、词尾与常见辅音群。 */
const GROUPS: [string, string][] = [
  ['tion', 'ション'], ['sion', 'ション'], ['ture', 'チャー'], ['sure', 'シュア'],
  ['ough', 'オー'], ['augh', 'オー'], ['eigh', 'エイ'], ['ight', 'アイト'],
  ['ing', 'イング'], ['ang', 'アング'], ['ong', 'オン'], ['ung', 'ウン'],
  ['ent', 'エント'], ['ant', 'アント'], ['est', 'エスト'], ['ist', 'イスト'],
  ['ain', 'エイン'], ['air', 'エア'], ['are', 'エア'], ['ere', 'イア'],
  ['ire', 'アイア'], ['ore', 'オア'], ['ure', 'ユア'], ['our', 'アワー'],
  ['ai', 'アイ'], ['ay', 'エイ'], ['au', 'オー'], ['aw', 'オー'],
  ['ea', 'イー'], ['ee', 'イー'], ['ei', 'エイ'], ['ey', 'エイ'],
  ['eu', 'ユー'], ['ew', 'ユー'], ['ie', 'アイ'], ['oa', 'オウ'],
  ['oe', 'オウ'], ['oi', 'オイ'], ['oy', 'オイ'], ['oo', 'ウー'],
  ['ou', 'アウ'], ['ow', 'オウ'], ['ue', 'ユー'], ['ui', 'ウィ'],
  ['ar', 'アー'], ['er', 'アー'], ['ir', 'アー'], ['or', 'オア'], ['ur', 'アー'],
  ['tch', 'ッチ'], ['dge', 'ッジ'], ['ck', 'ック'], ['ph', 'フ'], ['gh', ''],
  ['kn', 'ニ'], ['wr', 'ラ'], ['qu', 'ク'], ['mb', 'ム'], ['gn', 'ン'],
  ['ng', 'ング'], ['nk', 'ンク'], ['nt', 'ント'], ['mp', 'ンプ'],
  ['tr', 'トゥ'], ['dr', 'ドゥ'], ['ts', 'ツ'], ['ds', 'ズ'],
  ['str', 'ストゥ'], ['spr', 'スプ'], ['scr', 'スク'],
  ['ful', 'フル'], ['ment', 'メント'], ['ness', 'ネス'], ['able', 'アブル'],
  ['ly', 'リー'],
];

/** 常见词的固定读音（规则拼不出来的那几个）。 */
const WORDS: Record<string, string> = {
  hello: 'ハロー', hi: 'ハイ', sorry: 'ソーリー', thanks: 'サンクス',
  thank: 'サンク', you: 'ユー', please: 'プリーズ', okay: 'オーケー',
  yes: 'イエス', no: 'ノー', really: 'リアリー', good: 'グッド',
  great: 'グレイト', meeting: 'ミーティング', report: 'リポート',
  budget: 'バジェット', tomorrow: 'トゥモロー', today: 'トゥデイ',
  thursday: 'サーズデイ', tuesday: 'チューズデイ', monday: 'マンデイ',
  wednesday: 'ウェンズデイ', friday: 'フライデイ', time: 'タイム',
  one: 'ワン', two: 'トゥー', three: 'スリー', four: 'フォー', five: 'ファイブ',
  six: 'シックス', seven: 'セブン', eight: 'エイト', nine: 'ナイン', ten: 'テン',
  fifteen: 'フィフティーン', fifty: 'フィフティ', thousand: 'サウザンド',
  the: 'ザ', a: 'ア', an: 'アン', to: 'トゥ', of: 'オブ', is: 'イズ',
  are: 'アー', was: 'ワズ', were: 'ワー', not: 'ノット', have: 'ハブ',
  has: 'ハズ', can: 'キャン', will: 'ウィル', would: 'ウッド', could: 'クッド',
  should: 'シュッド', what: 'ワット', when: 'ウェン', where: 'ウェア',
  why: 'ワイ', how: 'ハウ', who: 'フー', this: 'ディス', that: 'ザット',
};

const VOWELS = 'aeiou';

function isVowel(letter: string) {
  return VOWELS.includes(letter);
}

/** 去掉词尾不发音的 e（make / like / there）。 */
function stripSilentE(word: string): string {
  if (word.length <= 3 || !word.endsWith('e')) return word;
  if (isVowel(word[word.length - 2])) return word;
  return [...word].filter(isVowel).length >= 2 ? word.slice(0, -1) : word;
}

function collapseDoubles(word: string): string {
  return word.replace(/([bcdfghjklmnpqrstvwxz])\1+/g, '$1');
}

/**
 * 一个英文词 → 片假名近似。
 *
 * 只处理字母；数字与符号原样留着（「3 p.m.」里的 3 不该被音译成サン）。
 */
export function enToKatakana(raw: string): string {
  const clean = String(raw ?? '')
    .toLowerCase()
    // 「p.m.」这种缩写里的点不该变成读音的一部分（原来会输出 プ.ム）。
    .replace(/([a-z])\.(?=[a-z])/g, '$1');
  if (!clean.trim()) return '';

  return clean
    .split(/([^a-z']+)/)
    .map((part) => {
      if (!part || !/[a-z]/.test(part)) return part;
      const word = part.replace(/[^a-z]/g, '');
      const direct = WORDS[word] ?? (word.length >= 3 ? WORDS[`${word}e`] : undefined);
      if (direct) return direct;

      let text = collapseDoubles(stripSilentE(word));
      let out = '';
      let index = 0;
      while (index < text.length) {
        const rest = text.slice(index);
        const triple = CV[rest.slice(0, 3)];
        if (triple) {
          out += triple;
          index += 3;
          continue;
        }
        const pair = CV[rest.slice(0, 2)];
        if (pair) {
          out += pair;
          index += 2;
          continue;
        }
        const group = GROUPS.find(([pattern]) => rest.startsWith(pattern));
        if (group) {
          out += group[1];
          index += group[0].length;
          continue;
        }
        const letter = text[index];
        const single: Record<string, string> = {
          a: 'ア', e: 'エ', i: 'イ', o: 'オ', u: 'ウ',
          b: 'ブ', c: 'ク', d: 'ド', f: 'フ', g: 'グ', h: 'フ', j: 'ジ',
          k: 'ク', l: 'ル', m: 'ム', n: 'ン', p: 'プ', q: 'ク', r: 'ル',
          s: 'ス', t: 'ト', v: 'ヴ', w: 'ウ', x: 'クス', y: 'イ', z: 'ズ',
        };
        out += single[letter] ?? '';
        index += 1;
      }
      return out;
    })
    .join('');
}
