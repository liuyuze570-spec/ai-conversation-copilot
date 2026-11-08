/**
 * Tone / emotion layer.
 *
 * Shared by the Mock LLM (offline demo data) and the real LLM prompt, so the
 * app speaks the same emotional language no matter which provider is active.
 *
 * Safety note: strong moods (angry / rant) vent about a SITUATION, never about
 * a person — no profanity, no slurs, no insults, no threats.
 */
import type { ToneKey } from '../shared/types';

export const TONE_LABELS: Record<ToneKey, string> = {
  auto: '自动',
  happy: '开心',
  sad: '难过',
  disappointed: '失望',
  excited: '期待',
  angry: '生气',
  grateful: '感谢',
  playful: '调侃',
  anxious: '担心',
  rant: '吐槽',
};

/** Ordered list used to render the tone picker chips. */
export const TONE_ORDER: ToneKey[] = [
  'auto',
  'happy',
  'excited',
  'grateful',
  'playful',
  'sad',
  'disappointed',
  'anxious',
  'angry',
  'rant',
];

/** Instructions injected into the LLM system prompt. */
export const TONE_RULES: Record<ToneKey, string> = {
  auto:
    'Match the mood of the conversation. If the other person is sad, sound gentle; if they are excited, sound upbeat. Never force an emotion that does not fit.',
  happy:
    "Sound genuinely happy and light. e.g. \"That's awesome!\", \"I'm so glad to hear that.\", \"That made my day.\"",
  sad:
    "Gentle, low-energy, honest sadness. e.g. \"That's rough.\", \"I'm sorry you're going through that.\", \"It's been a bit heavy lately.\" No melodrama.",
  disappointed:
    "Let the letdown show but stay polite. e.g. \"Honestly, that's a bit disappointing.\", \"I was really hoping it would work out.\"",
  excited:
    "Anticipation and energy. e.g. \"I can't wait!\", \"I'm really looking forward to it.\", \"That sounds so good.\"",
  angry:
    "Strong irritation, still respectful. e.g. \"That's so frustrating.\", \"Honestly, that's not okay.\", \"I'm really not happy about this.\" Criticise the situation, never the person.",
  grateful:
    "Warm thanks. e.g. \"I really appreciate it.\", \"Thanks, that means a lot.\", \"I couldn't have done it without you.\"",
  playful:
    "Light teasing and casual internet speech with friends. e.g. \"No way!\", \"That's wild.\", \"You're kidding, right?\", \"Honestly same.\" Never mean, never sarcastic at someone's expense.",
  anxious:
    "Worried or unsure. e.g. \"Not gonna lie, I'm kind of worried.\", \"I'm a bit nervous about it.\", \"I just don't want to mess this up.\"",
  rant:
    "Venting about a situation. e.g. \"This is driving me crazy.\", \"I'm so fed up with this.\", \"That's ridiculous.\" Complaining is fine — attacking people is not.",
};

/** Mock replies per tone: simple (easiest) / natural (casual) / continue (keeps it alive). */
export const TONE_REPLIES: Record<
  Exclude<ToneKey, 'auto'>,
  { simple: [string, string]; natural: [string, string]; continue: [string, string] }
> = {
  happy: {
    simple: ["That's great! I'm really happy for you.", '太好了！我真为你高兴。'],
    natural: ["Oh that's awesome, I'm so glad it worked out.", '哦太棒了，真高兴事情顺利。'],
    continue: [
      "That's so good to hear! What are you gonna do to celebrate?",
      '真替你开心！你打算怎么庆祝？',
    ],
  },
  sad: {
    simple: ["I'm sorry. That sounds really hard.", '抱歉，听起来真的很难熬。'],
    natural: ["That's rough. I'm sorry you're going through that.", '真不容易，很抱歉你正在经历这些。'],
    continue: [
      "I'm sorry to hear that. Do you want to talk about it?",
      '听到这个我很难过。你想聊聊吗？',
    ],
  },
  disappointed: {
    simple: ["Honestly, that's disappointing.", '说实话，挺让人失望的。'],
    natural: [
      "Yeah... I was really hoping it would work out.",
      '嗯……我本来真的希望这事能成。',
    ],
    continue: [
      "That's a bit of a letdown. What do we do now?",
      '有点让人失望。那我们现在怎么办？',
    ],
  },
  excited: {
    simple: ["I can't wait!", '我等不及了！'],
    natural: ["I'm really looking forward to it. It's gonna be fun.", '我特别期待，肯定会很好玩。'],
    continue: ["I'm so excited! When do we leave?", '我太期待了！我们什么时候出发？'],
  },
  angry: {
    simple: ["That's so frustrating.", '这太让人恼火了。'],
    natural: [
      "Honestly, that's really annoying. I'm not happy about it.",
      '说实话这挺让人生气的，我很不满意。',
    ],
    continue: [
      "That's frustrating. Can we get this fixed today?",
      '这让人很恼火。我们今天能解决吗？',
    ],
  },
  grateful: {
    simple: ['Thank you so much.', '太谢谢你了。'],
    natural: ['I really appreciate it. That helps a lot.', '真的很感谢，帮了我大忙。'],
    continue: [
      'Thanks, that means a lot. How can I return the favor?',
      '谢谢，这对我意义很大。我能怎么回报你？',
    ],
  },
  playful: {
    simple: ['No way! Are you serious?', '不会吧！你认真的？'],
    natural: ["That's wild. I did not expect that at all.", '太离谱了，我完全没想到。'],
    continue: [
      "Okay that's actually hilarious. What happened next?",
      '好吧这真的太好笑了。然后呢？',
    ],
  },
  anxious: {
    simple: ["I'm a bit nervous.", '我有点紧张。'],
    natural: ["Not gonna lie, I'm kind of worried about it.", '说实话，我有点担心。'],
    continue: [
      "I'm a little nervous. Do you think it'll be okay?",
      '我有点紧张。你觉得会没事吗？',
    ],
  },
  rant: {
    simple: ['This is driving me crazy.', '这快把我逼疯了。'],
    natural: [
      "Honestly, I'm so fed up with this. It never works.",
      '说实话我受够了，这玩意儿从来没好用过。',
    ],
    continue: [
      "That's ridiculous. Has anyone actually looked into it?",
      '太离谱了。有人真的去查过吗？',
    ],
  },
};

/**
 * 表达库：按「场景」分组，再按语气挑组。
 *
 * 为什么要分组：以前这一整块（含一堆 internet-casual 的 "I'm dead / lowkey yes"
 * 和强情绪的 "I'm fed up with this"）无条件塞进提示词。弱模型看到「正式」这条规则
 * 的同时又看到满屏网络俚语，结果两条都不听 —— 用户换了风格觉得「没变化」，换了
 * 语气也觉得「没变化」。现在按语气只给对口的几组：选了「正式」，网络俚语那一组
 * 根本不会出现在提示词里。
 */
const GROUPS = {
  everyday: `- Everyday: "How's it going?", "Long time no see", "Same here", "Fair enough", "Makes sense", "No worries", "Sounds good", "I'm down"`,
  life: `- Daily life: "I'm running a bit late", "Traffic was a nightmare", "I'm beat", "Let me grab a coffee first", "Let's call it a day", "It's on me"`,
  feelings: `- Feelings: "That means a lot", "I'm here for you", "It's been rough lately", "I'm glad we talked", "I miss this"`,
  close: `- Dating / close talk: "I really like spending time with you", "You make it easy to talk", "I felt a little left out", "I just wanted to check on you"`,
  net: `- Internet-casual (friends only): "No way", "That's wild", "I'm dead", "Lowkey yes", "Honestly same", "That hits different", "I feel you", "Say less"`,
  strong: `- Strong emotion (about a situation, never a person): "That's so frustrating", "I'm fed up with this", "This is driving me crazy", "That's ridiculous", "Are you kidding me?"`,
  sad: `- Sad / let-down: "That's rough", "It kind of sucks, honestly", "I'm gutted", "I was really hoping it would work out"`,
  hope: `- Hope / anticipation: "I can't wait", "Fingers crossed", "I'm counting down the days", "That sounds right up my alley"`,
};

type GroupId = keyof typeof GROUPS;

/** 每种语气只给对口的表达组 —— 语气越明确，给的越少，模型越不容易跑偏。 */
const GROUPS_BY_TONE: Record<ToneKey, GroupId[]> = {
  auto: ['everyday', 'life', 'feelings', 'close', 'net', 'strong', 'sad', 'hope'],
  happy: ['everyday', 'feelings', 'hope'],
  excited: ['hope', 'everyday', 'feelings'],
  grateful: ['feelings', 'everyday'],
  playful: ['net', 'everyday', 'close'],
  sad: ['sad', 'feelings'],
  disappointed: ['sad', 'feelings'],
  anxious: ['sad', 'feelings', 'hope'],
  angry: ['strong', 'everyday'],
  rant: ['strong', 'everyday'],
};

const GUIDE_TAIL = `NEVER: profanity, slurs, insults, threats, sexual content, or cruelty.
Strong emotion is always aimed at the SITUATION, never at a person.`;

/** 完整表达库（自动语气用）。保留这个常量是为了老调用方不会突然拿不到内容。 */
export const EXPRESSION_GUIDE = `SPOKEN EXPRESSION BANK (use what fits the moment, never force it):
${GROUPS_BY_TONE.auto.map((id) => GROUPS[id]).join('\n')}

${GUIDE_TAIL}`;

/**
 * 按语气（和风格）裁出来的表达库。
 *
 * `formal` 风格下再砍掉网络俚语和亲密表达 —— 面试里说 "I'm dead" 是灾难。
 */
export function expressionGuideFor(tone: ToneKey = 'auto', style?: string): string {
  const ids = (GROUPS_BY_TONE[tone] ?? GROUPS_BY_TONE.auto).filter((id) =>
    style === 'formal' ? id !== 'net' && id !== 'close' : true,
  );
  const picked = ids.length ? ids : ['everyday' as GroupId];
  const header =
    tone === 'auto'
      ? 'SPOKEN EXPRESSION BANK (use what fits the moment, never force it):'
      : `SPOKEN EXPRESSION BANK — only the lines that fit the mood "${TONE_LABELS[tone]}":`;
  return `${header}
${picked.map((id) => GROUPS[id]).join('\n')}

${GUIDE_TAIL}`;
}

/** Turns a tone entry into the 3 drafts the pipeline expects. */
export function toneDrafts(
  tone: ToneKey,
): { kind: 'simple' | 'natural' | 'continue'; english: string; chinese: string }[] | null {
  if (tone === 'auto') return null;
  const entry = TONE_REPLIES[tone];
  return [
    { kind: 'simple', english: entry.simple[0], chinese: entry.simple[1] },
    { kind: 'natural', english: entry.natural[0], chinese: entry.natural[1] },
    { kind: 'continue', english: entry.continue[0], chinese: entry.continue[1] },
  ];
}
