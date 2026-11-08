import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HintSystem } from '../../shared/languages';

/**
 * 双面沟通卡：一面给自己看，一面给对方看。
 *
 * 为什么需要两面：
 *  · 给**自己**看的一面要的是「我懂它的意思」+「我照着念得出来」，字不必很大；
 *  · 给**对方**看的一面要的是「他站在两米外也读得清」，所以去掉注音、去掉释义，
 *    只留一句目标语言的大字。
 *
 * 同一个屏幕上没法同时满足这两件事，所以做成可翻转的两面，而不是并排两栏
 * （460px 宽的悬浮窗并排只会两边都看不清）。
 *
 * ## 无障碍
 * 和沟通卡用同一套：portal 挂 body、背景 `inert`、Tab 锁在卡内、Esc 关闭、
 * 焦点回到底层那颗按钮。翻转是普通按钮，键盘可达。
 */
export function ShowCard({
  english,
  meaning,
  hint,
  hintSystem = 'hanzi',
  onSpeak,
  onClose,
}: {
  english: string;
  meaning?: string;
  hint?: string;
  hintSystem?: HintSystem;
  onSpeak: (text: string, speed?: number) => void;
  onClose: () => void;
}) {
  const [face, setFace] = useState<'me' | 'them'>('them');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    lastTrigger.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const root = document.querySelector<HTMLElement>('[data-app-shell]');
    if (root) root.inert = true;

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
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dialogRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (root) root.inert = false;
      lastTrigger.current?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={dialogRef}
      data-show-card
      role="dialog"
      aria-modal="true"
      aria-label={face === 'them' ? '给对方看的一面' : '给自己看的一面'}
      style={{ position: 'fixed', inset: 0, zIndex: 62 }}
      className="flex flex-col bg-black px-4 py-4"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11.5px] text-white/60">
          {face === 'them' ? '把屏幕转向对方' : '你自己看的这一面'}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-show-flip
            onClick={() => setFace((current) => (current === 'them' ? 'me' : 'them'))}
            className="no-drag rounded-lg border border-white/40 px-2.5 py-1 text-[11.5px] text-white
              transition-colors hover:bg-white/15"
          >
            {face === 'them' ? '看我的那一面' : '给对方看'}
          </button>
          <button
            ref={closeRef}
            type="button"
            data-show-close
            onClick={onClose}
            aria-label="关闭并回到字幕"
            className="no-drag rounded-lg border border-white/40 px-2.5 py-1 text-[11.5px] text-white
              transition-colors hover:bg-white/15"
          >
            关闭
          </button>
        </div>
      </div>

      {face === 'them' ? (
        <>
          {/*
            给对方看：只有一句目标语言的大字。
            这里不放注音和释义 —— 对方不需要知道你怎么念，也不需要中文解释。
          */}
          <p
            data-show-text
            className="mt-5 flex-1 select-text text-[30px] font-semibold leading-[1.35] text-white"
            style={{ userSelect: 'text' }}
          >
            {english}
          </p>
          <p className="mt-2 text-[10.5px] text-white/45">
            不会自动朗读，也不会发送给任何人 —— 需要出声时由你点下面的按钮。
          </p>
        </>
      ) : (
        <>
          {meaning ? (
            <p data-show-meaning className="mt-4 text-[19px] leading-snug text-white/85">
              {meaning}
            </p>
          ) : null}
          {hint ? (
            <p
              data-show-hint
              data-hint-system={hintSystem}
              className="mt-3 text-[24px] leading-snug text-accent-soft"
            >
              {hint}
            </p>
          ) : null}
          {hint ? (
            <p className="mt-1 text-[10px] text-white/35">
              {hintSystem === 'katakana'
                ? '片假名近似，不等于标准发音'
                : hintSystem === 'romaji'
                  ? '罗马字，不等于标准发音'
                  : '汉字近似，不等于标准发音'}
            </p>
          ) : null}
          <p
            data-show-text
            className="mt-3 flex-1 select-text text-[20px] leading-[1.4] text-white"
            style={{ userSelect: 'text' }}
          >
            {english}
          </p>
          {/*
            时间 / 金额这类「听错一个数字就白谈」的信息，光看字幕不够。
            确认句的生成在「重点信息」里（勾选事实 → 帮我确认），这里只把路指过去，
            不做「自动确认」—— 自动替用户说「我确认」是另一回事。
          */}
          <p data-show-confirm-tip className="mt-2 text-[10.5px] leading-relaxed text-white/40">
            时间或金额不确定？关掉这张卡，在「重点信息」里勾上那几条点「帮我确认」，
            会生成一句「我理解的是……，对吗？」给你直接给对方看。
          </p>
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-show-speak
          onClick={() => onSpeak(english)}
          className="no-drag rounded-xl border border-white/40 px-3 py-2 text-[12px] text-white
            transition-colors hover:bg-white/15"
        >
          朗读（需手动点）
        </button>
        <button
          type="button"
          data-show-speak-slow
          onClick={() => onSpeak(english, 0.7)}
          className="no-drag rounded-xl border border-white/40 px-3 py-2 text-[12px] text-white
            transition-colors hover:bg-white/15"
        >
          慢速
        </button>
      </div>
    </div>,
    document.body,
  );
}
