/**
 * 不依赖网络的固定沟通卡。
 *
 * 「我没听清」原本走的是 AI 回复流程：要联网、要花额度、要等好几秒。
 * 但真实的尴尬场景是**对方正站在你面前等回应**——这时候最需要的是
 * 一秒就能举给对方看的一句话，而不是一段需要生成的建议。
 *
 * 所以这三张卡是写死的：点开立刻显示，不请求任何接口，断网也能用。
 * 注意它们是**辅助展示**，不自动发到聊天软件里 —— 发不发、发给谁由用户决定。
 */

export interface CommCard {
  id: string;
  /** 给使用者看的中文（自己知道点了什么）。 */
  zh: string;
  /** 举给对方看的外语短句。 */
  en: string;
  /** 什么情况下用这一张。 */
  note: string;
}

export const COMM_CARDS: CommCard[] = [
  {
    id: 'again',
    zh: '请再说一遍',
    en: 'Sorry, could you say that again?',
    note: '没听清整句时用，比「啊？」更有礼貌',
  },
  {
    id: 'slower',
    zh: '请慢一点',
    en: 'Could you speak a little slower, please?',
    note: '对方语速太快，字幕跟不上时用',
  },
  {
    id: 'write',
    zh: '请把关键时间写下来',
    en: 'Could you write down the time and date for me?',
    note: '涉及时间、日期、数字时用 —— 写下来比听一遍可靠',
  },
];

export function commCard(id: string): CommCard | undefined {
  return COMM_CARDS.find((card) => card.id === id);
}

/**
 * 举卡时显示的大字内容。
 *
 * 只放外语：这张卡是给对方看的，混进中文会让对方以为要读两段。
 * 中文在卡片上方的小字里，给使用者自己确认。
 */
export function cardDisplayText(card: CommCard): string {
  return card.en;
}

/** 复制到剪贴板的内容：两句都给，粘到聊天窗口时对方能看懂，自己也对得上。 */
export function cardClipboardText(card: CommCard): string {
  return `${card.en}\n（${card.zh}）`;
}
