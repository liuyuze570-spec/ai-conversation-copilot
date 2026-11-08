import type { ReplyStyle, ResponseLength, ScenarioMode, TargetLanguage, ToneKey } from '../../shared/types';
import type { HintSystem } from '../../shared/languages';
import { COMPREHENSION_NAMES } from '../../shared/languages';
import { defaultLevelFor } from '../../shared/levels';
import type { ReplyMode, ReplyRequest } from '../types';
import { expressionGuideFor, TONE_LABELS, TONE_RULES } from '../tone';

/**
 * 语言水平 → 用词难度。
 *
 * **每门语言一套刻度**：英语是国内考试等级（B 级～专八），俄语是大学俄语 / 专业俄语，
 * 日语是 JLPT N5～N1，韩语是 TOPIK 1～6 级。
 *
 * 之前只有英语一套，选了日语之后提示词仍然在对模型说「Chinese College English Test
 * Band 4」——模型要么忽略，要么用英语的难度去写日语，两种都不对。现在按语言取表，
 * 每档都写清「用几个词、什么句式、能不能用地道省略」。
 */
interface LevelRule {
  /** 写进提示词的难度要求。 */
  rule: string;
  /** 第一行「给什么水平的学习者」用的可读描述（模型不认识 CET-4 这种缩写）。 */
  name: string;
}

const ENGLISH_LEVELS: Record<string, LevelRule> = {
  pretcoB: {
    rule: 'Use 4-8 very common words. Simple present tense. Short fragments are fine.',
    name: 'beginner (Chinese English Grade B)',
  },
  pretcoA: {
    rule: 'Use 8-14 words. One simple complete sentence with everyday words.',
    name: 'elementary (Chinese English Grade A)',
  },
  cet4: {
    rule: 'Use 1-2 natural sentences. Everyday vocabulary; no rare or bookish words.',
    name: 'intermediate (Chinese College English Test Band 4)',
  },
  cet6: {
    rule: 'You may use richer words and common idioms, but keep it easy to say out loud.',
    name: 'upper-intermediate (Chinese College English Test Band 6)',
  },
  tem4: {
    rule: 'Relaxed natural spoken English. Phrasal verbs and light idioms are welcome.',
    name: 'advanced (English major, TEM-4)',
  },
  tem8: {
    rule: 'Close to how a native casually talks — still spoken, never written.',
    name: 'near-native (English major, TEM-8)',
  },
};

const RUSSIAN_LEVELS: Record<string, LevelRule> = {
  'ru-basic': {
    rule: 'Use 3-6 very common words in the present tense. Phrases like "Да, конечно." are enough.',
    name: 'beginner in Russian',
  },
  'ru-crt4': {
    rule: 'Use one short complete sentence with everyday words. No rare vocabulary.',
    name: 'lower-intermediate (Chinese College Russian Test Band 4)',
  },
  'ru-crt6': {
    rule:
      'You may use richer vocabulary and common set phrases, but keep every sentence easy to say out loud.',
    name: 'upper-intermediate (Chinese College Russian Test Band 6)',
  },
  'ru-tr4': {
    rule:
      'Relaxed natural spoken Russian. Common colloquial particles (ну, вот, же, ведь) are welcome.',
    name: 'advanced (Russian major, Chinese Russian TEM-4)',
  },
  'ru-tr8': {
    rule: 'Close to how a native casually talks — spoken register only, never bookish or written.',
    name: 'near-native (Russian major, Chinese Russian TEM-8)',
  },
};

const JAPANESE_LEVELS: Record<string, LevelRule> = {
  'ja-n5': {
    rule: 'Use 3-8 words in です／ます form. Only the most common words and particles.',
    name: 'beginner (JLPT N5)',
  },
  'ja-n4': {
    rule: 'Use one short sentence in です／ます or plain form with everyday vocabulary.',
    name: 'elementary (JLPT N4)',
  },
  'ja-n3': {
    rule:
      'Use 1-2 sentences of natural casual Japanese (だ／た form). Common conjunctions like でも / だから are fine.',
    name: 'intermediate (JLPT N3)',
  },
  'ja-n2': {
    rule:
      'Use natural casual Japanese with common set expressions. Sentence-final particles (よ / ね / けど) are welcome.',
    name: 'upper-intermediate (JLPT N2)',
  },
  'ja-n1': {
    rule:
      'Close to how a native casually talks — omissions and contractions (〜ちゃう / 〜じゃん) are fine, but keep it spoken.',
    name: 'near-native (JLPT N1)',
  },
};

const KOREAN_LEVELS: Record<string, LevelRule> = {
  'ko-t1': {
    rule: 'Use 3-6 words in 해요 form. Only the most common words.',
    name: 'beginner (TOPIK Level 1)',
  },
  'ko-t2': {
    rule: 'Use one short sentence in 해요 form with everyday vocabulary.',
    name: 'elementary (TOPIK Level 2)',
  },
  'ko-t3': {
    rule: 'Use 1-2 sentences; 해요 form, or casual 반말 between friends is fine.',
    name: 'intermediate (TOPIK Level 3)',
  },
  'ko-t4': {
    rule:
      'Use richer everyday vocabulary and common expressions, still easy to say out loud.',
    name: 'upper-intermediate (TOPIK Level 4)',
  },
  'ko-t5': {
    rule: 'Natural colloquial Korean with common contractions (거든요 / 잖아요 / -네요).',
    name: 'advanced (TOPIK Level 5)',
  },
  'ko-t6': {
    rule: 'Close to how a native casually talks — spoken register only, never written.',
    name: 'near-native (TOPIK Level 6)',
  },
};

const LEVEL_TABLES: Record<TargetLanguage, Record<string, LevelRule>> = {
  English: ENGLISH_LEVELS,
  Russian: RUSSIAN_LEVELS,
  Japanese: JAPANESE_LEVELS,
  Korean: KOREAN_LEVELS,
};

/**
 * 取某语言某等级的用词规则。
 *
 * 值不认识时（老设置、手工改坏）回**该语言**的默认档，而不是英语四级 ——
 * 否则一个日语用户会拿到英语的规则。
 */
export function levelGuidance(language: TargetLanguage, level: string | undefined): LevelRule {
  const table = LEVEL_TABLES[language] ?? ENGLISH_LEVELS;
  const fallback = table[defaultLevelFor(language)] ?? ENGLISH_LEVELS.cet4;
  return (level ? table[level] : undefined) ?? fallback;
}

/**
 * 回复风格。
 *
 * 之前每条只有一句话（"Light humour, never offensive."），弱模型基本看不出
 * 差别，用户换了风格却觉得「表达没变」。这里补上具体的用词要求和一个示范，
 * 让「简单 / 自然 / 热情 / 幽默 / 正式」真的能被区分出来。
 */
const STYLE_RULES: Record<ReplyStyle, string> = {
  simple:
    'Use the plainest, most common words. No idioms, no slang, no long clauses. ' +
    'e.g. "That sounds good. Let\'s do it."',
  natural:
    'Exactly how a real person casually talks on a video call. Contractions are welcome. ' +
    'e.g. "Oh nice, I\'d love to hear more about that."',
  friendly:
    'Warm and enthusiastic — show you are glad the person is talking to you. Add feeling. ' +
    'e.g. "That\'s so great to hear! I\'m really happy for you."',
  funny:
    'Light, playful humour with a small joke or a self-deprecating line. ' +
    'Teasing is fine, never rude or offensive. e.g. "Well, that escalated fast. Count me in."',
  formal:
    'Polite and professional — suitable for an interview or a client call. ' +
    'No slang, no "gonna / wanna", no jokes. e.g. "Thank you for clarifying. I will follow up shortly."',
};

const LENGTH_RULES: Record<ResponseLength, string> = {
  short: 'Prefer the shortest version that still answers.',
  normal: 'Balanced length.',
  detailed: 'You may add one short extra sentence of context.',
};

/**
 * 风格（怎么说）与语气（什么情绪）冲突时谁说了算。
 *
 * 这两项都是用户自己设的，模型很容易挑一个自己喜欢的写。所以优先级必须写死，
 * 并且明确「设置大于模型自己的口味，也大于对话本身的气氛」。
 */
const STYLE_TONE_NOTE =
  'STYLE sets the WORDING and politeness level. MOOD sets the EMOTION. ' +
  'Both are settings chosen by the user — follow them exactly, never substitute your own taste. ' +
  'When they pull in different directions, keep the user\'s style for wording and their mood for feeling ' +
  '(e.g. 正式 + 调侃 = a dry, polite remark, never a loud joke).';

/** 语气在英文里的说法，直接拼进提示词，别让模型去猜「期待」是什么情绪。 */
const TONE_IN_ENGLISH: Record<ToneKey, string> = {
  auto: 'whatever the other person sounds like',
  happy: 'happy and light',
  sad: 'gently sad',
  disappointed: 'let down but polite',
  excited: 'excited and full of anticipation',
  angry: 'irritated but respectful',
  grateful: 'warmly thankful',
  playful: 'playful and teasing',
  anxious: 'worried and a little unsure',
  rant: 'venting about a situation',
};

/**
 * 语气段落。
 *
 * 用户的原话是「必须按别人的设置来回复」「要是自动的话，那就看对面说啥」——
 * 所以这里分成两个完全不同的指令：指定了情绪就是硬约束，一句话都不许跑偏；
 * 选了自动才交给模型去读对方最后一句。
 */
function moodGuide(tone: ToneKey): string {
  if (tone === 'auto') {
    return `MOOD — 自动（由你判断，不要固定成一种情绪）
1. Read the LAST line the other person said (newest line in RECENT CONVERSATION).
2. Decide how they sound: happy / excited / grateful / playful / sad / worried / annoyed / neutral.
3. EVERY one of the three replies must carry that same feeling.
   - happy or excited → warm and upbeat.
   - sad, tired or disappointed → gentle and low-key. Never cheerful over bad news.
   - annoyed or complaining → calm and on their side. Never bouncy.
   - neutral → stay neutral. Do not invent emotion that is not there.
The other person sets the mood here, not you.`;
  }
  return `MOOD — 固定为「${TONE_LABELS[tone]}」（用户选的，必须照做）
The user set the mood to "${TONE_LABELS[tone]}" (${TONE_IN_ENGLISH[tone]}).
EVERY one of the three replies must clearly sound that way. This is a hard requirement:
- Do NOT switch to another emotion.
- Do NOT tone it down to neutral.
- Do NOT let what the other person said override this setting.
All three cards share this mood, but must still differ in wording and sentence shape.
${TONE_RULES[tone]}`;
}

/**
 * The same three-card output is reused for every scenario, but what each card
 * should CONTAIN changes a lot: a live chat wants an answer, a video wants a
 * spontaneous reaction, and an exam listener wants the key point plus a model
 * answer. Spell that out so the three modes never blur together.
 */
const SCENARIO_RULES: Record<ScenarioMode, string> = {
  conversation:
    'SCENARIO: live two-way conversation. The other person is waiting for the user to answer out loud.',
  video:
    'SCENARIO: the user is WATCHING a video / movie / stream. The speaker cannot hear the user. ' +
    'The user pauses the video to think, so give spontaneous reactions and comments they could say out loud ' +
    'or type in a comment box. React to what was just said; do not ask the video a question as if it can reply.',
  exam:
    'SCENARIO: CET-4/6 (四六级) LISTENING practice. Treat the transcript as exam audio. ' +
    'Card 1 = the KEY POINT of the listening restated simply. ' +
    'Card 2 = a model answer a candidate could actually say if asked about it. ' +
    'Card 3 = one exam-appropriate sentence that extends the topic. ' +
    'Stay factual: only use information present in the transcript, never invent details.',
};

/**
 * 「读音提示」这一段怎么写。
 *
 * 0.5.0 在这里写死了「用汉字标英语的音」。选日语的用户拿到的还是一行汉字，
 * 选英语的用户想要罗马字也拿不到。现在按提示体系分别写要求，
 * 并且明确「宁可空着，也不要编」——编出来的提示会让人照着念错。
 */
function hintInstruction(system: HintSystem, target: string, isEnglish: boolean): string {
  if (system === 'none') return '"".';
  if (system === 'katakana') {
    return `REQUIRED. Japanese KATAKANA that sound like the ${target} sentence, word by word,
  joined with single spaces. Example: "How are you doing?" → ハウ アー ユー ドゥーイング
  Use only katakana and ー. Never Chinese characters, never romaji, never the sentence itself.`;
  }
  if (system === 'romaji') {
    return `REQUIRED. Hepburn-style ROMAJI of the ${target} sentence exactly as you wrote it,
  lowercase, words separated by spaces. Example: もう一度お願いします → mou ichido onegai shimasu
  Use only Latin letters. Never Chinese characters, never the original text.`;
  }
  return `REQUIRED. A SOUND hint written in Chinese characters, NOT a translation.
  Go through the ${target} sentence word by word; for EACH WORD write Chinese
  characters that sound like that word, then join the per-word pieces with a single space.
  english "How are you doing?" → 好 阿 优 度英 (4 words → 4 pieces)
  It MUST be completely different from the "meaning" field.${
    isEnglish
      ? ''
      : ' It is a hint, so approximate is fine — but it must follow THIS sentence word by word.'
  }`;
}

function systemPrompt(request: ReplyRequest): string {
  const tone: ToneKey = request.tone ?? 'auto';
  const scenario: ScenarioMode = request.scenario ?? 'conversation';
  const language = request.language ?? 'English';
  const isEnglish = language === 'English';
  const languageName: Record<string, string> = {
    English: 'English',
    Russian: 'Russian (Русский)',
    Japanese: 'Japanese (日本語)',
    Korean: 'Korean (한국어)',
  };
  const target = languageName[language] ?? 'English';
  const comprehension = request.comprehension ?? 'Chinese';
  const meaningName = COMPREHENSION_NAMES[comprehension as keyof typeof COMPREHENSION_NAMES] ?? 'Simplified Chinese (简体中文)';
  const hintSystem: HintSystem = request.hintSystem ?? 'hanzi';
  const hintRule = hintInstruction(hintSystem, target, isEnglish);
  const profile = request.profile
    ? [
        request.profile.name ? `Name: ${request.profile.name}` : '',
        request.profile.city ? `City: ${request.profile.city}` : '',
        request.profile.interests ? `Interests: ${request.profile.interests}` : '',
      ]
      .filter(Boolean)
      .join('\n')
    : '';

  // 按「对话语言 + 该语言的等级」取用词规则；不认识的值回该语言的默认档。
  const { rule: levelRule, name: levelName } = levelGuidance(
    language as TargetLanguage,
    request.level,
  );

  return `You are a real-time spoken-${target} copilot for a ${levelName} learner.
The learner UNDERSTANDS ${meaningName} but wants to SPEAK ${target}.

GOAL
Help the user say something out loud in the next 3 seconds. You are NOT showing off
language skills and you are NOT writing an email.

${moodGuide(tone)}
STYLE: ${STYLE_RULES[request.style]}
${STYLE_TONE_NOTE}

${SCENARIO_RULES[scenario]}

HARD RULES
0. STYLE and MOOD above are the user's own settings. Follow them exactly — they
   outrank your personal taste AND the mood of the conversation.
1. Natural spoken ${target}. Short. Easy to pronounce. Context aware.
   Write in ${target} script${isEnglish ? '' : ' (Russian: Cyrillic, Japanese: kana/kanji, Korean: Hangul)'}.
2. ${levelRule}
3. Wording must follow the STYLE above (do not replace it with your own default tone).
4. ${LENGTH_RULES[request.length]}
5. NEVER invent facts about the user (no trips, jobs, family, experiences).
   If the answer depends on unknown personal facts, hedge and ask back, e.g.
   "Not yet, but I'd love to go someday. How about you?"
6. Avoid uncommon vocabulary and long complex sentences.
7. No emoji, no quotation marks around the sentence, no explanations.
8. Every reply must express the MOOD above. If it does not, rewrite it.
9. Sound like a real person, not a textbook. Prefer natural spoken phrasing.
10. The three replies must be GENUINELY different from each other — different
    wording and different sentence shape, not the same sentence trimmed short.

${expressionGuideFor(tone, request.style)}

${profile ? `ABOUT THE USER (only use if relevant):\n${profile}\n` : ''}
OUTPUT FORMAT
Return ONLY valid JSON — one object, nothing else.

STRICT JSON RULES (a broken JSON means the user gets no reply at all)
- EVERY string value MUST be wrapped in double quotes — including "ipa" and
  "readingHint". Never write a bare value such as "ipa": tʃaɪld.
- Escape a double quote inside a value as \\".
- No trailing commas, no comments, no markdown.

{"replies":[{"kind":"simple|natural|continue","english":"...","meaning":"...","ipa":"...","syllables":["Rea-lly","what made you"],"readingHint":"...","romanization":"..."}]}

- "simple": easiest to say.${scenario === 'exam' ? ' (key point of the listening)' : scenario === 'video' ? ' (short spontaneous reaction)' : ''}
- "natural": how a native speaker would casually say it.${scenario === 'exam' ? ' (model answer for a candidate)' : scenario === 'video' ? ' (natural comment on what was said)' : ''}
- "continue": answers AND keeps the conversation alive with a short follow-up question.${scenario === 'exam' ? ' (extends the topic in exam-appropriate language)' : scenario === 'video' ? ' (a thought to continue the video, no question to the speaker)' : ''}
- "english": the reply in ${target}. Every entry MUST have one.
- "meaning": a natural, colloquial translation of "english" into ${meaningName}
  (口语化, NOT word by word). This is what the user reads to understand what they are about to say.
- "readingHint": ${hintRule}
- "ipa": ${
  isEnglish
    ? 'English IPA sounds for the whole sentence, no slashes. NEVER Chinese pinyin, NEVER tone marks, NEVER the English sentence itself. Use "" when you are not sure — an empty string is always better than a wrong one.'
    : 'IPA if you know it, otherwise "".'
}
- "syllables": ${
  isEnglish
    ? 'REQUIRED. Chunks of the ENGLISH sentence itself, in order, showing where to breathe. Every chunk must be English letters. Example: ["Rea-lly", "what made you", "say that"]'
    : 'optional reading chunks.'
}${
  isEnglish
    ? ''
    : `
- "romanization": Latin reading aid — Russian: translit (privyet), Japanese: romaji (hisashibori), Korean: revised romanization (oraenmaniya). MUST match the text you returned.`
}`;
}

const MODE_INSTRUCTION: Record<ReplyMode, string> = {
  reply: 'Generate 3 clearly different replies (simple / natural / continue).',
  simple: 'Rewrite the current sentence to be much simpler and easier to say.',
  natural: 'Rewrite the current sentence so it sounds like real casual spoken English.',
  continue: 'Write one short reply that answers and then asks a natural follow-up question.',
  rephrase: 'Give a different way to say the same thing. Same meaning, different words.',
  simplify: 'Make the current sentence shorter and much easier to pronounce.',
  'didnt-catch':
    'The user did not understand. Give 3 short polite ways to ask the other person to repeat or slow down.',
  'from-chinese':
    'The user typed their own sentence (in the language they understand). Turn it into 3 natural spoken versions (simple / natural / continue) in the target language. Keep the meaning faithful — do NOT add or drop information — but make it sound natural, not translated word by word.',
};

export function buildReplyMessages(
  request: ReplyRequest,
): { role: 'system' | 'user'; content: string }[] {
  const parts: string[] = [];
  parts.push(`RECENT CONVERSATION (oldest → newest):\n${request.context || '(none yet)'}`);
  parts.push('');
  const language = request.language ?? 'English';
  parts.push(`TASK: ${MODE_INSTRUCTION[request.mode]}`);
  parts.push(`Write the replies in ${language}.`);
  if (request.current) parts.push(`CURRENT REPLY TO WORK FROM: "${request.current}"`);
  if (request.chinese) {
    // 用户输入的是「他自己的话」，不一定是中文 —— 一个日语使用者会打日语。
    parts.push(`USER'S OWN WORDS (${request.comprehension ?? 'Chinese'}): "${request.chinese}"`);
    parts.push('Keep exactly the same meaning, numbers and times. Only the language changes.');
  }
  parts.push('');
  parts.push('Respond with JSON only.');

  return [
    { role: 'system', content: systemPrompt(request) },
    { role: 'user', content: parts.join('\n') },
  ];
}

/**
 * 语言的「可读名字」。
 *
 * 只写 "English" 模型还能懂，但 "Chinese" 会被一部分模型理解成繁体或文言，
 * 所以把简体/字体也一起写清楚。同时这也修掉了一个真 bug：以前的翻译提示词
 * 把源语言和译入语言**写死成「英语 → 中文」**，设置里的「母语」因此完全
 * 不生效（母语选了英语，译文还是中文）。
 */
const LANGUAGE_NAMES: Record<string, string> = {
  Chinese: 'Simplified Chinese (简体中文)',
  English: 'English',
  Russian: 'Russian (Русский)',
  Japanese: 'Japanese (日本語)',
  Korean: 'Korean (한국어)',
};

function languageName(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return LANGUAGE_NAMES[value] ?? value;
}

export function buildTranslateMessages(
  text: string,
  context: string[] = [],
  languages: { from?: string; to?: string } = {},
) {
  const from = languageName(languages.from, 'English');
  const to = languageName(languages.to, 'Simplified Chinese (简体中文)');

  return [
    {
      role: 'system' as const,
      content: `You are the live-subtitle translator inside a real-time conversation app.

TASK: translate spoken ${from} into natural, colloquial ${to}.

RULES
- Translate the MEANING for a live video-call / movie context. Never word by word.
- Keep it as short as a subtitle. No lead-ins like "这句话的意思是", no commentary.
- Output ONLY the translation: no quotes, no notes, no pinyin, no original text.
- Keep numbers, names, brands, cities and product names as they are.
- If the line breaks off mid-sentence, translate only what was actually said —
  never invent an ending that nobody said.
- The recent conversation is only there to disambiguate pronouns and referents.
  Never repeat it, and never answer it.`,
    },
    {
      role: 'user' as const,
      content: context.length
        ? `Recent conversation (oldest → newest):\n${context.join('\n')}\n\nTranslate this line:\n${text}`
        : `Translate this line:\n${text}`,
    },
  ];
}

export function buildCorrectionMessages(
  userText: string,
  context: string[],
  language: TargetLanguage = 'English',
  comprehension = 'Chinese',
) {
  const spoken = LANGUAGE_NAMES[language] ?? 'English';
  const noteLang = COMPREHENSION_NAMES[comprehension as keyof typeof COMPREHENSION_NAMES] ?? 'Simplified Chinese (简体中文)';
  return [
    {
      role: 'system' as const,
      content: `You are a friendly spoken-${spoken} coach.
Given what the user just said, respond with JSON only:
{"needsCorrection":true|false,"natural":"...","note":"..."}
- Only flag something if it would genuinely sound unnatural to a native speaker.
- "note" must be under 12 characters, written in ${noteLang}, e.g. "very like 在口语里不自然".
- Keep the meaning identical, keep the length similar, keep it spoken.`,
    },
    {
      role: 'user' as const,
      content: `Context:\n${context.join('\n') || '(none)'}\n\nUser said:\n${userText}`,
    },
  ];
}
