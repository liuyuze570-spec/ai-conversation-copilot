import type { ScenarioMode } from '../../shared/types';
import type { ComprehensionLanguage } from '../../shared/languages';
import type { LLMProvider, ReplyDraft, ReplyRequest } from '../types';
import { enrichDrafts } from '../pronunciation';
import { toneDrafts } from '../tone';
import { LANGUAGE_REPLIES } from './corpus';

/**
 * 演示模式下，非中文理解方向只给下面这组**固定回复**。
 *
 * 为什么不复用中文那几十套：`ReplyDraft.chinese` 是释义字段，写死中文的话，
 * 一个理解语言是日语的用户会看到一句他读不懂的「释义」。而给几十套台词逐句
 * 补日语释义，等于凭空生成几十句没人核对过的译文 —— 不如就把演示范围收窄到
 * 六句覆盖三组样例的回复，每句的日语释义都写在同一张表里，一眼能核。
 */
const DEMO_REPLIES_JA: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'Sorry, could you say that again?',
    chinese: '抱歉，你能再说一遍吗？',
    meaning: 'すみません、もう一度言っていただけますか。',
  },
  {
    kind: 'simple',
    english: 'So the meeting is on Thursday at 10:30, right?',
    chinese: '所以会议是周四十点半，对吗？',
    meaning: '会議は木曜日の10時30分で合っていますか。',
  },
  {
    kind: 'simple',
    english: 'Just to confirm, it is fifteen thousand, not fifty thousand, right?',
    chinese: '确认一下，是一万五，不是五万，对吗？',
    meaning: '確認ですが、5万ではなく1万5千ですね。',
  },
  {
    kind: 'natural',
    english: "That works for me. I'll send it by 3 p.m. tomorrow.",
    chinese: '我没问题。明天下午三点前发过去。',
    meaning: '大丈夫です。明日の午後3時までに送ります。',
  },
  {
    kind: 'natural',
    english: 'Got it, thank you.',
    chinese: '明白了，谢谢。',
    meaning: '了解しました。ありがとうございます。',
  },
  {
    kind: 'continue',
    english: 'Could you also send me the details in writing?',
    chinese: '能把细节也发我一份文字版吗？',
    meaning: '詳細を文章でも送っていただけますか。',
  },
];

/** 拿不到对应语言的释义时宁可写明白，也不把中文塞给读不懂中文的人。 */
const MEANING_MISSING: Partial<Record<ComprehensionLanguage, string>> = {
  Japanese: '（この返事の意味はデモ用に未収録です）',
  English: '(no meaning recorded for this reply in demo mode)',
};

/** 逐句补 `meaning`：优先用草稿自带的，其次用下表，最后写「未收录」。 */
function withMeaning(
  drafts: ReplyDraft[],
  comprehension: ComprehensionLanguage,
): ReplyDraft[] {
  if (comprehension === 'Chinese') return drafts;
  const missing = MEANING_MISSING[comprehension];
  return drafts.map((draft) => {
    if (draft.meaning) return draft;
    return missing ? { ...draft, meaning: missing } : draft;
  });
}


const GENERIC: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'That sounds great. Tell me more about it.',
    chinese: '听起来不错。再多跟我说说吧。',
  },
  {
    kind: 'natural',
    english: "Oh nice, I'd love to hear more about that.",
    chinese: '哦不错，我很想多听听这个。',
  },
  {
    kind: 'continue',
    english: "That's interesting. How did you get into it?",
    chinese: '挺有意思的。你是怎么开始接触这个的？',
  },
];

const DIDNT_CATCH: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'Sorry, could you say that again?',
    chinese: '抱歉，你能再说一遍吗？',
  },
  {
    kind: 'natural',
    english: 'Sorry, I missed that. Could you say it again?',
    chinese: '抱歉，我刚才没听清，能再说一次吗？',
  },
  {
    kind: 'continue',
    english: 'Sorry, could you speak a little more slowly? I want to get it right.',
    chinese: '抱歉，你能说慢一点吗？我想听清楚。',
  },
];

const TRAVEL: ReplyDraft[] = [
  {
    kind: 'simple',
    english: "Yes, I've been there. It's a really nice place.",
    chinese: '是的，我去过那里。那里很不错。',
  },
  {
    kind: 'natural',
    english: 'Yeah, I went once. I really liked the food there.',
    chinese: '去过一次。我特别喜欢那里的食物。',
  },
  {
    kind: 'continue',
    english: "I've been there once. What made you want to go?",
    chinese: '我去过一次。你为什么想去那里？',
  },
];

const WORK: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'Got it. I will take care of that today.',
    chinese: '明白了。我今天会处理。',
  },
  {
    kind: 'natural',
    english: 'Makes sense. Let me check and get back to you this afternoon.',
    chinese: '有道理。我确认一下，下午回复你。',
  },
  {
    kind: 'continue',
    english: "Sounds good. Do you need anything else from my side?",
    chinese: '听起来没问题。我这边还需要提供什么吗？',
  },
];

const FEELINGS: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'I miss you too. It feels like forever.',
    chinese: '我也想你。感觉像过了好久。',
  },
  {
    kind: 'natural',
    english: 'That means a lot to me. I think about you all the time.',
    chinese: '这话对我意义很大。我一直都在想你。',
  },
  {
    kind: 'continue',
    english: "I miss you too. When do you think you can come visit?",
    chinese: '我也想你。你觉得自己什么时候能来看我？',
  },
];

const SLANG: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'No way! Are you serious?',
    chinese: '不会吧！你认真的？',
  },
  {
    kind: 'natural',
    english: "That's wild. I did not expect that at all.",
    chinese: '太离谱了，我完全没想到。',
  },
  {
    kind: 'continue',
    english: "Okay that's hilarious. What happened next?",
    chinese: '好吧这太好笑了。然后呢？',
  },
];

const COMFORT: ReplyDraft[] = [
  {
    kind: 'simple',
    english: "I'm sorry. That sounds really hard.",
    chinese: '抱歉，听起来真的很难熬。',
  },
  {
    kind: 'natural',
    english: "That's rough. I'm here if you want to talk.",
    chinese: '真不容易。你想聊的话我都在。',
  },
  {
    kind: 'continue',
    english: "I'm sorry to hear that. Is there anything I can do?",
    chinese: '听到这个我很难过。有什么我能帮上忙的吗？',
  },
];

const STUDY: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'Same here. I understand more than I can say.',
    chinese: '我也是。我听得懂的比说得出的多。',
  },
  {
    kind: 'natural',
    english: 'Yeah, speaking is the hard part for me too.',
    chinese: '是啊，对我来说"说"也是最难的部分。',
  },
  {
    kind: 'continue',
    english: 'Same here. Want to practice together for ten minutes?',
    chinese: '我也是。要不要一起练十分钟？',
  },
];

const FOOD: ReplyDraft[] = [
  {
    kind: 'simple',
    english: "That sounds good. Let's do it.",
    chinese: '听起来不错。就这么定了。',
  },
  {
    kind: 'natural',
    english: "Oh I'm in. I've been wanting to try that place.",
    chinese: '哦我加入。我一直想去试试那家。',
  },
  {
    kind: 'continue',
    english: "I'm down. What time works for you?",
    chinese: '我去。你几点方便？',
  },
];

/** Watching a video: the speaker cannot hear you, so react instead of answering. */
const VIDEO_REPLIES: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'Wait, what just happened?',
    chinese: '等等，刚刚发生了什么？',
  },
  {
    kind: 'natural',
    english: "Okay, I did not see that coming at all.",
    chinese: '好吧，我完全没想到会是这样。',
  },
  {
    kind: 'continue',
    english: 'That was intense. I have to see how this ends.',
    chinese: '太紧张了。我得看看后面怎么发展。',
  },
];

/** CET-4/6 listening: key point + a model answer a candidate could say. */
const EXAM_REPLIES: ReplyDraft[] = [
  {
    kind: 'simple',
    english: 'The key point is that the meeting has been moved to Friday.',
    chinese: '关键要点是：会议改到了周五。',
  },
  {
    kind: 'natural',
    english: 'So the main idea is that the speaker prefers the new plan.',
    chinese: '所以大意是：说话人更支持新方案。',
  },
  {
    kind: 'continue',
    english: 'According to the passage, the change mainly saves both time and money.',
    chinese: '根据短文，这一改变主要节省了时间和费用。',
  },
];

/** Scene detection for the `auto` tone: pick replies that fit the topic. */
const SCENES: { pattern: RegExp; replies: ReplyDraft[] }[] = [
  { pattern: /miss you|love|date|lonely|relationship|feel about/i, replies: FEELINGS },
  { pattern: /travel|visit|trip|flight|hotel|vacation|holiday|weekend away/i, replies: TRAVEL },
  { pattern: /deadline|meeting|demo|design|review|timeline|blocker|work|boss|team/i, replies: WORK },
  { pattern: /no way|that's wild|i'm dead|meme|lol|dude|hilarious/i, replies: SLANG },
  { pattern: /rough|tough|hard day|sad|upset|awful|terrible/i, replies: COMFORT },
  { pattern: /english|practice|speak|learn|pronounc/i, replies: STUDY },
  { pattern: /food|eat|dinner|lunch|pizza|noodle|restaurant|starving|hungry/i, replies: FOOD },
];

function sceneReplies(context: string): ReplyDraft[] {
  const lastForeign = [...context.split('\n')].reverse().find((line) =>
    line.startsWith('Foreign:'),
  );
  const haystack = `${lastForeign ?? ''}\n${context}`;
  const match = SCENES.find((scene) => scene.pattern.test(haystack));
  if (match) return match.replies;

  const isQuestion = /\?\s*$/.test((lastForeign ?? context).trim());
  if (!isQuestion) return GENERIC;

  return [
    {
      kind: 'simple',
      english: 'Sure, I like it a lot.',
      chinese: '当然，我很喜欢。',
    },
    {
      kind: 'natural',
      english: 'Yeah, I really enjoy it. It helps me relax.',
      chinese: '嗯，我挺喜欢的，能让我放松。',
    },
    {
      kind: 'continue',
      english: 'Yeah, I do. How about you? What do you usually do?',
      chinese: '嗯，会的。你呢？你一般做什么？',
    },
  ];
}

/**
 * Which offline reply set to use, given what the user is listening to.
 * Video reactions and exam answers are deliberately different from the
 * conversational defaults, so switching scenario visibly changes the output.
 */
function scenarioReplies(scenario: ScenarioMode, context: string): ReplyDraft[] {
  if (scenario === 'video') return VIDEO_REPLIES;
  if (scenario === 'exam') return EXAM_REPLIES;
  return sceneReplies(context);
}

/**
 * Pick the best base reply for a refine request (简单一点 / 换一种说法 / 更自然).
 *
 * These used to return one hard-coded sentence no matter what was being
 * discussed, which fell apart the moment anyone actually tried the feature.
 * Now they reuse the same scene detection as `自动` so the rewrite at least
 * stays on topic.
 */
function baseReplyFor(
  context: string,
  kind: ReplyDraft['kind'],
  scenario: ScenarioMode = 'conversation',
): ReplyDraft {
  const scene = scenarioReplies(scenario, context);
  return (
    scene.find((draft) => draft.kind === kind) ??
    scene.find((draft) => draft.kind === 'natural') ??
    scene[0] ??
    GENERIC[0]
  );
}

/** Hold the meaning, change the shape: drop a clause vs. keep it whole. */
function toSimple(source: ReplyDraft): ReplyDraft {
  const text = source.english.replace(/\s+/g, ' ').trim();
  const clauses = text
    .split(/[,;.?!]/)
    .map((part) => part.trim())
    .filter(Boolean);

  // A one-word fragment ("Yeah") is useless to read out loud — keep dropping
  // to the shortest clause that still stands on its own.
  let head = clauses[0] ?? text;
  for (const clause of clauses) {
    if (clause.split(' ').length >= 3) {
      head = clause;
      break;
    }
    head = head.split(' ').length >= clause.split(' ').length ? head : clause;
  }
  return { kind: 'simple', english: head, chinese: source.chinese };
}

/** Vary the opener so repeated taps do not feel scripted. */
const REPHRASE_OPENERS = ['Actually, ', 'Well, ', 'To be honest, ', 'Hmm, ', 'I mean, '];
let rephraseTick = 0;

function toRephrase(source: ReplyDraft): ReplyDraft {
  const text = source.english.replace(/\s+/g, ' ').trim();
  const opener = REPHRASE_OPENERS[rephraseTick % REPHRASE_OPENERS.length];
  rephraseTick += 1;
  return {
    kind: 'natural',
    english: `${opener}${text.charAt(0).toLowerCase()}${text.slice(1)}`,
    chinese: source.chinese,
  };
}

/** Modes where a forced tone makes sense (the user wants to SPEAK that mood). */
const TONE_MODES = new Set(['reply', 'continue', 'natural', 'from-chinese']);

/**
 * Mock LLM: deterministic, offline, instantly usable.
 * It exists so the whole pipeline can be developed and demoed before any
 * API key is configured — it is never used when a real provider is enabled.
 */
export class MockLLM implements LLMProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock LLM (offline)';

  async generateReplies(request: ReplyRequest): Promise<ReplyDraft[]> {
    await delay(320);
    const context = request.context || '';
    const language = request.language ?? 'English';
    const scenario: ScenarioMode = request.scenario ?? 'conversation';
    const comprehension = (request.comprehension ?? 'Chinese') as ComprehensionLanguage;
    const finish = (drafts: ReplyDraft[]) =>
      enrichDrafts(withMeaning(drafts, comprehension), language, request.hintSystem ?? 'hanzi');

    // Russian / Japanese / Korean: offline replies in that language.
    if (language !== 'English') {
      const localized = LANGUAGE_REPLIES[language];
      if (localized?.length) return finish(localized);
    }

    /*
     * 日语理解 + 英语表达：只给演示用的固定六句。
     *
     * 其余几十套中文台词没有日语释义，拿中文释义顶上去等于给用户看天书；
     * 逐句补日语又是在批量生产没人核对过的译文。收窄范围是更诚实的做法。
     */
    if (comprehension === 'Japanese') {
      return finish(DEMO_REPLIES_JA);
    }

    // An explicit tone always wins: the user asked to sound a certain way.
    // (An exam answer is never "playful", so the exam keeps its own voice.)
    if (
      request.tone &&
      request.tone !== 'auto' &&
      TONE_MODES.has(request.mode) &&
      scenario !== 'exam'
    ) {
      const drafts = toneDrafts(request.tone);
      if (drafts) return finish(drafts);
    }

    switch (request.mode) {
      case 'didnt-catch':
        return finish(DIDNT_CATCH);
      case 'simplify':
      case 'simple':
        // Stay on topic: simplify whatever the scenario suggests for the reply.
        return finish([toSimple(baseReplyFor(context, 'natural', scenario))]);
      case 'rephrase':
        return finish([toRephrase(baseReplyFor(context, 'natural', scenario))]);
      case 'continue':
        return finish([baseReplyFor(context, 'continue', scenario)]);
      case 'natural':
        return finish([baseReplyFor(context, 'natural', scenario)]);
      case 'from-chinese':
        // Without a real LLM we can only mirror the shape of the request; keep
        // the three kinds so the UI still shows simple / natural / continue.
        return finish([
          toSimple(baseReplyFor(context, 'simple', scenario)),
          baseReplyFor(context, 'natural', scenario),
          baseReplyFor(context, 'continue', scenario),
        ]);
      default:
        return finish(scenarioReplies(scenario, context));
    }
  }

  async complete(prompt: string): Promise<string> {
    await delay(200);
    return `[mock] ${prompt.slice(0, 40)}...`;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
