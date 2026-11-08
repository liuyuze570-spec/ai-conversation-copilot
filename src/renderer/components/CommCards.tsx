import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { COMM_CARDS, cardClipboardText, type CommCard } from '../../shared/comm-cards';

/**
 * 三张固定沟通卡（不联网、不花额度）。
 *
 * 和「帮我回复」的区别：那个要联网、要等几秒、还可能要花钱；这三张是写死的，
 * 点开就显示，断网也能用。真实的场景是**对方正站在你面前等回应** ——
 * 这时候一秒能举起来的一句话，比一段更漂亮的建议有用得多。
 *
 * 只做一件事：把一句话放大给对方看。不自动朗读、不自动发送，
 * 免得在会议里突然出声或者把你的话发到群里。
 *
 * ## 无障碍（这一版补齐的三件事）
 * 1. **焦点锁在卡片里**：Tab / Shift+Tab 只在卡片的几个按钮之间循环，
 *    不会跑到背后被遮住的控件上；
 * 2. **背景真的不可操作**：卡片用 portal 挂到 body 上，同时把应用外壳设成
 *    `inert` —— 键盘和鼠标都碰不到背景（只靠视觉遮盖挡不住 Tab）；
 * 3. **Esc 与「关闭」都能退出，焦点回到打开它的那颗按钮**。
 */
export function CommCards({
  onSpeak,
  compact = false,
}: {
  /** 朗读（可选）。只有用户点了「朗读」才会用到，绝不自动触发。 */
  onSpeak: (text: string) => void;
  /** 大字模式：去掉「沟通卡」这行标头，三颗按钮保住一行不折行。 */
  compact?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const card = COMM_CARDS.find((item) => item.id === openId) ?? null;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!card) return;
    closeRef.current?.focus();

    const root = document.querySelector<HTMLElement>('[data-app-shell]');
    if (root) root.inert = true;

    /** 只把这一层里真正可聚焦的元素算进来。 */
    const focusables = (): HTMLElement[] => {
      const node = dialogRef.current;
      if (!node) return [];
      return Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        setOpenId(null);
        return;
      }
      if (event.key !== 'Tab') return;
      /*
       * 手写 Tab 循环，而不是只靠 aria-modal。
       *
       * aria-modal 只是告诉读屏「外面不算」；浏览器仍然会把焦点移出去。
       * 真实走查里，只加 aria-modal 时按一下 Tab 焦点就跑到背后的「开始采集」
       * 上了 —— 那正是「背景控件被键盘操作」。
       */
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !active || !dialogRef.current?.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !active || !dialogRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (root) root.inert = false;
      lastTrigger.current?.focus();
      setCopied(false);
    };
  }, [card]);

  const copy = async (target: CommCard) => {
    try {
      await navigator.clipboard.writeText(cardClipboardText(target));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板可能被系统策略禁掉；不是致命问题，卡片本身还能给对方看。
      setCopied(false);
    }
  };

  return (
    <>
      <div data-comm-cards className="flex min-w-0 flex-wrap items-center gap-1.5">
        {!compact && <span className="label shrink-0 !text-white/40">沟通卡</span>}
        {COMM_CARDS.map((item) => (
          <button
            key={item.id}
            type="button"
            data-comm-card={item.id}
            title={`${item.note}（不联网，点了立刻显示）`}
            aria-label={`显示沟通卡：${item.zh}`}
            onClick={(event) => {
              lastTrigger.current = event.currentTarget;
              setOpenId(item.id);
            }}
            className="no-drag rounded-xl border border-line bg-ink-850 px-2 py-1 text-[11.5px]
              text-white/75 transition-colors hover:border-accent/40 hover:bg-ink-800 hover:text-white"
          >
            {item.zh}
          </button>
        ))}
      </div>

      {card &&
        createPortal(
          <div
            ref={dialogRef}
            data-comm-overlay
            role="dialog"
            aria-modal="true"
            aria-label={`沟通卡：${card.zh}`}
            style={{ position: 'fixed', inset: 0, zIndex: 60 }}
            className="flex flex-col bg-black px-4 py-4"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-white/80">{card.zh}</p>
                <p className="mt-0.5 text-[10.5px] leading-relaxed text-white/55">{card.note}</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                data-comm-close
                onClick={() => setOpenId(null)}
                aria-label="关闭沟通卡并回到字幕"
                className="no-drag shrink-0 rounded-lg border border-white/40 px-2.5 py-1 text-[11.5px]
                  text-white transition-colors hover:bg-white/15"
              >
                关闭
              </button>
            </div>

            {/*
              * 给对方看的那句话：纯白字压纯黑底、30px 加粗。
              *
              * 这两个颜色是**实际渲染**的（父层 bg-black 是 #000，文字 color 是
              * 继承的白色），不是只在文档里算一算。自检会读 getComputedStyle 的
              * 真实 color / background-color 再按 WCAG 公式核一次。
              */}
            <p
              data-comm-text
              className="mt-4 flex-1 select-text text-[30px] font-semibold leading-[1.35] text-white"
              style={{ userSelect: 'text' }}
            >
              {card.en}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-comm-copy
                onClick={() => void copy(card)}
                className="no-drag rounded-xl border border-white/40 px-3 py-2 text-[12px] text-white
                  transition-colors hover:bg-white/15"
              >
                {copied ? '已复制' : '复制英文'}
              </button>
              <button
                type="button"
                data-comm-speak
                onClick={() => onSpeak(card.en)}
                className="no-drag rounded-xl border border-white/40 px-3 py-2 text-[12px] text-white
                  transition-colors hover:bg-white/15"
              >
                朗读（需手动点）
              </button>
              <span className="ml-auto text-[10px] text-white/60">不会自动发送给任何人</span>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
