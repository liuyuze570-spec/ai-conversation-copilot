/**
 * Offline corpus used by Mock / Demo mode.
 *
 * Covers the situations people actually end up in on a video call:
 * daily small talk, daily-life errands, dating & feelings, friend/internet
 * slang, venting, work meetings, travel and study.
 *
 * Each line carries its Chinese translation so the demo looks like the real
 * pipeline (subtitle + translation) without any API key.
 */
import type { TargetLanguage } from '../../shared/types';
import type { ReplyDraft } from '../types';

export interface DemoLine {
  speaker: 'foreign' | 'user';
  english: string;
  chinese: string;
  confidence: number;
}

export interface Scenario {
  id: string;
  name: string;
  lines: DemoLine[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'daily',
    name: '日常寒暄',
    lines: [
      {
        speaker: 'foreign',
        english: 'Hey! Long time no see. How have you been?',
        chinese: '嗨！好久不见。你最近怎么样？',
        confidence: 0.95,
      },
      {
        speaker: 'user',
        english: "I've been good, just really busy with work lately.",
        chinese: '挺好的，就是最近工作特别忙。',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: "Same here. Honestly, I'm beat most days.",
        chinese: '我也是。说实话我大部分时间都累瘫了。',
        confidence: 0.91,
      },
      {
        speaker: 'foreign',
        english: 'By the way, are you doing anything fun this weekend?',
        chinese: '对了，你这周末有什么好玩的安排吗？',
        confidence: 0.93,
      },
      {
        speaker: 'user',
        english: 'Not much, probably just stay home and catch up on sleep.',
        chinese: '没什么，大概就待在家补觉吧。',
        confidence: 0.88,
      },
      {
        speaker: 'foreign',
        english: "Fair enough. I might go check out that new noodle place.",
        chinese: '有道理。我可能会去试试那家新开的面馆。',
        confidence: 0.86,
      },
    ],
  },
  {
    id: 'life',
    name: '生活琐事',
    lines: [
      {
        speaker: 'foreign',
        english: "Sorry I'm late, traffic was a nightmare.",
        chinese: '抱歉我迟到了，路上堵得要命。',
        confidence: 0.92,
      },
      {
        speaker: 'user',
        english: 'No worries, I just got here myself.',
        chinese: '没事，我自己也刚到。',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: "Did you order yet? I'm starving.",
        chinese: '你点了吗？我快饿死了。',
        confidence: 0.89,
      },
      {
        speaker: 'user',
        english: "Not yet, let's split a pizza or something.",
        chinese: '还没，我们点个披萨什么的分着吃吧。',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: "Works for me. I'm down for whatever, honestly.",
        chinese: '我都可以。说实话吃什么都行。',
        confidence: 0.78,
      },
      {
        speaker: 'foreign',
        english: "Oh, and it's on me tonight. You paid last time.",
        chinese: '对了，今晚我请客，上次你付的。',
        confidence: 0.91,
      },
    ],
  },
  {
    id: 'feelings',
    name: '感情 / 想念',
    lines: [
      {
        speaker: 'foreign',
        english: "I miss you. It's been way too long.",
        chinese: '我想你了。已经太久没见了。',
        confidence: 0.94,
      },
      {
        speaker: 'user',
        english: 'I miss you too. When are you coming back?',
        chinese: '我也想你。你什么时候回来？',
        confidence: 0.92,
      },
      {
        speaker: 'foreign',
        english: "Next month, hopefully. I'm counting down the days.",
        chinese: '希望是下个月。我每天都在数日子。',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: "Do you ever feel like it's hard to keep this up?",
        chinese: '你有没有觉得这样维持下去很难？',
        confidence: 0.87,
      },
      {
        speaker: 'user',
        english: 'Sometimes. But talking with you makes it easy.',
        chinese: '有时候会。但跟你聊天就变得容易了。',
        confidence: 0.85,
      },
      {
        speaker: 'foreign',
        english: "That means a lot. I'm really glad we talked tonight.",
        chinese: '这话对我意义很大。真高兴今晚我们能聊聊。',
        confidence: 0.93,
      },
    ],
  },
  {
    id: 'slang',
    name: '朋友闲聊 / 网络用语',
    lines: [
      {
        speaker: 'foreign',
        english: 'Dude, you will not believe what happened today.',
        chinese: '兄弟，你绝对想不到今天发生了什么。',
        confidence: 0.93,
      },
      {
        speaker: 'user',
        english: 'What? Tell me everything.',
        chinese: '什么？快全告诉我。',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: 'My boss accidentally replied all with a meme.',
        chinese: '我们老板不小心把表情包群发全员了。',
        confidence: 0.8,
      },
      {
        speaker: 'user',
        english: "No way. That's wild.",
        chinese: '不会吧。太离谱了。',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: "I'm dead. The whole office went silent.",
        chinese: '我笑死了。整个办公室都安静了。',
        confidence: 0.88,
      },
      {
        speaker: 'foreign',
        english: 'Honestly best thing that happened all week.',
        chinese: '说实话这是这周最棒的事。',
        confidence: 0.85,
      },
    ],
  },
  {
    id: 'work',
    name: '工作会议',
    lines: [
      {
        speaker: 'foreign',
        english: 'Can we go over the timeline for this week?',
        chinese: '我们能过一下这周的时间安排吗？',
        confidence: 0.95,
      },
      {
        speaker: 'user',
        english: "Sure, I'll share the updated deck in a bit.",
        chinese: '当然，我一会儿把更新后的材料发给你。',
        confidence: 0.91,
      },
      {
        speaker: 'foreign',
        english: 'Great. Any blockers I should know about?',
        chinese: '好。有什么卡住的地方需要我知道吗？',
        confidence: 0.9,
      },
      {
        speaker: 'user',
        english: "Just one — we're still waiting on the design review.",
        chinese: '只有一个——我们还在等设计评审。',
        confidence: 0.88,
      },
      {
        speaker: 'foreign',
        english: 'Got it. Let me chase them today.',
        chinese: '明白了。我今天去催一下他们。',
        confidence: 0.92,
      },
      {
        speaker: 'foreign',
        english: 'Also, are we still on for the demo on Thursday?',
        chinese: '还有，周四的演示还照常吗？',
        confidence: 0.79,
      },
    ],
  },
  {
    id: 'rant',
    name: '吐槽 / 强烈情绪',
    lines: [
      {
        speaker: 'foreign',
        english: 'Ugh, my flight got delayed again.',
        chinese: '唉，我的航班又延误了。',
        confidence: 0.9,
      },
      {
        speaker: 'user',
        english: "Again? That's so frustrating.",
        chinese: '又来了？这太让人恼火了。',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: "Third time this month. I'm so fed up with this airline.",
        chinese: '这个月第三次了。我受够这家航空公司了。',
        confidence: 0.88,
      },
      {
        speaker: 'foreign',
        english: "They said two hours, but I'm not holding my breath.",
        chinese: '他们说两小时，但我可不敢指望。',
        confidence: 0.85,
      },
      {
        speaker: 'user',
        english: "That's ridiculous. Did they offer anything?",
        chinese: '太离谱了。他们有什么补偿吗？',
        confidence: 0.87,
      },
      {
        speaker: 'foreign',
        english: "A five dollar voucher. I'm done with them, honestly.",
        chinese: '一张五美元的代金券。说实话我跟他们到此为止了。',
        confidence: 0.82,
      },
    ],
  },
  {
    id: 'comfort',
    name: '低落 / 安慰',
    lines: [
      {
        speaker: 'foreign',
        english: 'Honestly, today was rough.',
        chinese: '说实话，今天挺难熬的。',
        confidence: 0.92,
      },
      {
        speaker: 'user',
        english: 'Oh no, what happened?',
        chinese: '啊，怎么了？',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: 'Nothing huge. Just one of those days.',
        chinese: '没什么大事。就是那种什么都不顺的一天。',
        confidence: 0.86,
      },
      {
        speaker: 'user',
        english: 'I get that. Do you want to talk about it?',
        chinese: '我懂。你想聊聊吗？',
        confidence: 0.89,
      },
      {
        speaker: 'foreign',
        english: 'Maybe later. Thanks for asking, it helps.',
        chinese: '可能待会儿吧。谢谢你问，这让我好受点。',
        confidence: 0.87,
      },
    ],
  },
  {
    id: 'travel',
    name: '旅行计划',
    lines: [
      {
        speaker: 'foreign',
        english: "I'm thinking about taking a trip next month.",
        chinese: '我在想下个月去旅行一趟。',
        confidence: 0.93,
      },
      {
        speaker: 'user',
        english: 'Oh nice, where to?',
        chinese: '哦不错，去哪儿？',
        confidence: 0.9,
      },
      {
        speaker: 'foreign',
        english: "Maybe Chengdu. I've always wanted to try the food there.",
        chinese: '可能是成都。我一直想试试那里的美食。',
        confidence: 0.9,
      },
      {
        speaker: 'user',
        english: "That's a great pick. How long are you planning to stay?",
        chinese: '选得好。你打算待多久？',
        confidence: 0.88,
      },
      {
        speaker: 'foreign',
        english: 'About five days. Do you want to come?',
        chinese: '大概五天。你想一起去吗？',
        confidence: 0.91,
      },
    ],
  },
  {
    id: 'study',
    name: '学习 / 练口语',
    lines: [
      {
        speaker: 'foreign',
        english: "How's your English practice going?",
        chinese: '你的英语练习进展怎么样？',
        confidence: 0.94,
      },
      {
        speaker: 'user',
        english: 'Slowly. I understand more than I can say.',
        chinese: '挺慢的。我听得懂的比说得出的多。',
        confidence: 0.88,
      },
      {
        speaker: 'foreign',
        english: "That's totally normal. Speaking is always the hard part.",
        chinese: '这很正常。说永远是最难的部分。',
        confidence: 0.92,
      },
      {
        speaker: 'foreign',
        english: 'Want to just chat for ten minutes every day?',
        chinese: '要不要每天就聊十分钟？',
        confidence: 0.9,
      },
    ],
  },
];

/** Sample scripts for the non-English target languages (demo playback). */
export const LANGUAGE_SCENARIOS: Partial<Record<TargetLanguage, Scenario[]>> = {
  Russian: [
    {
      id: 'ru-daily',
      name: '俄语 · 日常寒暄',
      lines: [
        {
          speaker: 'foreign',
          english: 'Привет! Как дела?',
          chinese: '嗨！你最近怎么样？',
          confidence: 0.94,
        },
        {
          speaker: 'user',
          english: 'Всё хорошо, спасибо. А у тебя?',
          chinese: '一切都好，谢谢。你呢？',
          confidence: 0.9,
        },
        {
          speaker: 'foreign',
          english: 'Тоже нормально. Ты занят в эти выходные?',
          chinese: '我也还行。你这周末忙吗？',
          confidence: 0.88,
        },
        {
          speaker: 'foreign',
          english: 'Может, сходим куда-нибудь поесть?',
          chinese: '要不我们一起去吃点什么？',
          confidence: 0.91,
        },
      ],
    },
  ],
  Japanese: [
    {
      id: 'ja-daily',
      name: '日语 · 久别重逢',
      lines: [
        {
          speaker: 'foreign',
          english: '久しぶり！元気だった？',
          chinese: '好久不见！你还好吗？',
          confidence: 0.94,
        },
        {
          speaker: 'user',
          english: 'うん、元気だよ。最近ちょっと忙しくて。',
          chinese: '嗯，挺好的。最近有点忙。',
          confidence: 0.9,
        },
        {
          speaker: 'foreign',
          english: 'そっか。今度ご飯でも行かない？',
          chinese: '这样啊。下次一起去吃个饭吗？',
          confidence: 0.9,
        },
        {
          speaker: 'foreign',
          english: '時間があるときでいいから、教えてね。',
          chinese: '等你有空的时候告诉我就行。',
          confidence: 0.86,
        },
      ],
    },
  ],
  Korean: [
    {
      id: 'ko-daily',
      name: '韩语 · 周末邀约',
      lines: [
        {
          speaker: 'foreign',
          english: '오랜만이야! 잘 지냈어?',
          chinese: '好久不见！过得好吗？',
          confidence: 0.93,
        },
        {
          speaker: 'user',
          english: '응, 잘 지냈어. 요즘 좀 바빴어.',
          chinese: '嗯，过得不错。最近有点忙。',
          confidence: 0.9,
        },
        {
          speaker: 'foreign',
          english: '그렇구나. 이번 주말에 시간 있어?',
          chinese: '这样啊。这周末有空吗？',
          confidence: 0.88,
        },
        {
          speaker: 'foreign',
          english: '같이 밥이나 먹으러 가자.',
          chinese: '一起去吃个饭吧。',
          confidence: 0.91,
        },
      ],
    },
  ],
};

/** Offline replies for the non-English target languages. */
export const LANGUAGE_REPLIES: Partial<Record<TargetLanguage, ReplyDraft[]>> = {
  Russian: [
    {
      kind: 'simple',
      english: 'Всё хорошо, спасибо.',
      chinese: '一切都好，谢谢。',
    },
    {
      kind: 'natural',
      english: 'Да всё нормально, не переживай.',
      chinese: '嗯，一切都正常，别担心。',
    },
    {
      kind: 'continue',
      english: 'Всё хорошо. А ты как?',
      chinese: '挺好的。你呢？',
    },
  ],
  Japanese: [
    {
      kind: 'simple',
      english: 'はい、大丈夫です。',
      chinese: '嗯，没问题。',
      meaning: 'Yes, that works for me.',
    },
    {
      kind: 'natural',
      english: 'うん、全然いいよ。',
      chinese: '嗯，完全没问题。',
      meaning: 'Yeah, that is totally fine.',
    },
    {
      kind: 'continue',
      english: '大丈夫だよ。で、何時ごろ行く？',
      chinese: '没问题。那你大概几点去？',
      meaning: 'Sure. So around what time will you go?',
    },
  ],
  Korean: [
    {
      kind: 'simple',
      english: '네, 괜찮아요.',
      chinese: '是的，没问题。',
    },
    {
      kind: 'natural',
      english: '응, 완전 괜찮아.',
      chinese: '嗯，完全没问题。',
    },
    {
      kind: 'continue',
      english: '괜찮아요. 그럼 몇 시에 갈까요?',
      chinese: '没问题。那我们几点去？',
    },
  ],
};

/** english → chinese lookup built from every scenario. */
export const TRANSLATIONS: Record<string, string> = Object.values(
  LANGUAGE_SCENARIOS,
)
  .flat()
  .concat(SCENARIOS)
  .reduce((map, scenario) => {
    for (const line of scenario.lines) map[line.english] = line.chinese;
    return map;
  }, {} as Record<string, string>);

/** Fallback keyword hints for sentences outside the scripted scenarios. */
export const WORD_HINTS: [RegExp, string][] = [
  [/^hey\b|^hi\b|^hello\b|^yo\b/i, '嗨'],
  [/\bdude\b/i, '兄弟'],
  [/\bhow are you\b|\bhow have you been\b|\bhow's it going\b/i, '你最近怎么样'],
  [/\blong time no see\b/i, '好久不见'],
  [/\bthank(s| you)\b|\bappreciate it\b/i, '谢谢'],
  [/\bsorry\b|\bmy bad\b/i, '抱歉'],
  [/\bmiss you\b/i, '想你'],
  [/\bi'm beat\b|\bexhausted\b|\btired\b/i, '累坏了'],
  [/\bweekend\b/i, '周末'],
  [/\btomorrow\b|\bnext week\b/i, '明天 / 下周'],
  [/\btraffic\b/i, '堵车'],
  [/\bflight\b|\bdelayed\b|\bairport\b/i, '航班 / 延误'],
  [/\bstarving\b|\bhungry\b|\bfood\b|\bnoodle\b|\bpizza\b/i, '吃的'],
  [/\btravel\b|\bvisit\b|\btrip\b|\bvacation\b|\bholiday\b/i, '旅行'],
  [/\bwork\b|\bdeadline\b|\bmeeting\b|\bdemo\b/i, '工作'],
  [/\bboss\b|\bcolleague\b|\bteam\b/i, '同事 / 团队'],
  [/\bweather\b/i, '天气'],
  [/\bno way\b|\bthat's wild\b|\bi'm dead\b/i, '不会吧 / 太离谱'],
  [/\bfed up\b|\bfrustrating\b|\bridiculous\b|\bannoying\b/i, '受够了 / 很恼火'],
  [/\brough\b|\bhard\b|\bsad\b|\bupset\b/i, '难熬 / 难过'],
  [/\bexcited\b|\bcan't wait\b|\blooking forward\b/i, '期待'],
  [/\bnervous\b|\bworried\b|\banxious\b/i, '担心 / 紧张'],
];
