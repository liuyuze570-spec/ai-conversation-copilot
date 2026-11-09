import { useEffect, useState, type ReactNode } from 'react';
import type { PlannedReply } from '@shared/reply-plan';

/**
 * 回复卡。
 *
 * 一张卡上必须同时有：用途、英文、中文、按短语分段的汉字近音，以及
 * 朗读 / 慢速 / 停止 / 复制 / 大字 / 编辑。少一样，用户就得多做一步，
 * 而这几步恰恰是他最不方便做的。
 *
 * 无障碍上的三条决定：
 *  1. 近音默认**折叠**。读屏默认把英文、中文、近音连着念三遍，等于听三段
 *     杂音；需要的人自己打开，打开后也只在近音区域里读。
 *  2. 每条按钮的语义名称都带用途（「朗读：确认金额…」），因为一屏有三张卡，
 *     都叫「朗读」的话，读屏用户根本分不清在念哪一句。
 *  3. 复制/朗读的结果用一句短提示 + role="status"，不抢焦点、不重复播报。
 */
export function ReplyCards({
  cards,
  sourceNote,
  onSpeak,
  onStop,
  onEdit,
  onShowBig,
}: {
  cards: PlannedReply[];
  sourceNote: string;
  onSpeak: (text: string, rate: number) => void;
  onStop: () => void;
  onEdit: (id: string, en: string) => void;
  onShowBig: (card: PlannedReply) => void;
}): ReactNode {
  const [showPhon, setShowPhon] = useState(false);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [status, setStatus] = useState('');

  // 离开这一块（换了一句话）时把正在念的停掉。
  useEffect(() => () => onStop(), [onStop]);

  const copy = async (text: string, purpose: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`已复制「${purpose}」的英文`);
    } catch {
      setStatus('这个浏览器不让复制，请选中英文后手动复制');
    }
  };

  return (
    <section className="mt-5" aria-labelledby="reply-heading" data-testid="reply-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="reply-heading" className="text-[13px] font-medium tracking-wide text-white/80">
          4 · 可以回的话
        </h2>
        <span className="text-[11.5px] text-white/45" data-testid="reply-source">
          {sourceNote}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[12px] text-white/70">
          <input
            type="checkbox"
            checked={showPhon}
            onChange={(event) => setShowPhon(event.target.checked)}
            data-testid="phon-toggle"
            aria-describedby="phon-disclaimer"
          />
          显示汉字近音辅助
        </label>
        <span id="phon-disclaimer" className="text-[11px] text-white/40">
          汉字近音仅帮助开口，不是标准音标，也不替代英语发音
        </span>
      </div>

      <ul className="mt-2 space-y-2">
        {cards.map((card, index) => (
          <li
            key={card.id}
            className="rounded-xl border border-white/10 bg-white/4 p-3"
            data-testid={`reply-card-${index}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[11px] text-white/80" data-testid={`reply-purpose-${index}`}>
                {card.purpose}
              </span>
              <span className="text-[11px] text-white/35">{card.why}</span>
            </div>

            {/* 英文：语言标记必须是 en，读屏才会用英语发音规则念。 */}
            <p
              lang="en"
              className="mt-1.5 text-[16px] leading-snug text-white"
              data-testid={`reply-en-${index}`}
            >
              {card.en}
            </p>
            {/* 中文：语言标记 zh-CN，避免被当成英语念出来。 */}
            <p lang="zh-CN" className="mt-1 text-[12.5px] leading-snug text-white/60" data-testid={`reply-zh-${index}`}>
              {card.zh}
            </p>

            {showPhon ? (
              <div className="mt-2 rounded-lg border border-dashed border-white/15 bg-ink-950/40 p-2" data-testid={`reply-phon-${index}`}>
                <p className="text-[11px] text-white/40">分段近音（按短语切开，不是逐字母转写）</p>
                <ul className="mt-1 space-y-1">
                  {card.segments.map((segment, segmentIndex) => (
                    <li key={`${card.id}-seg-${segmentIndex}`} className="flex flex-wrap items-baseline gap-2">
                      <span lang="en" className="text-[13px] text-white/85">
                        {segment.en}
                      </span>
                      <span className="text-[12.5px] text-accent/90" aria-label="汉字近音">
                        {segment.phon || '（这一小段没有可靠近音）'}
                      </span>
                      {segment.zh ? (
                        <span lang="zh-CN" className="text-[11.5px] text-white/45">
                          {segment.zh}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/85"
                aria-label={`朗读：${card.purpose}`}
                data-testid={`reply-speak-${index}`}
                onClick={() => onSpeak(card.en, 1)}
              >
                朗读
              </button>
              <button
                type="button"
                className="rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/85"
                aria-label={`慢速朗读：${card.purpose}`}
                data-testid={`reply-slow-${index}`}
                onClick={() => onSpeak(card.en, 0.6)}
              >
                慢速
              </button>
              <button
                type="button"
                className="rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/85"
                aria-label="停止朗读"
                data-testid={`reply-stop-${index}`}
                onClick={onStop}
              >
                停止
              </button>
              <button
                type="button"
                className="rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/85"
                aria-label={`复制英文：${card.purpose}`}
                data-testid={`reply-copy-${index}`}
                onClick={() => void copy(card.en, card.purpose)}
              >
                复制英文
              </button>
              <button
                type="button"
                className="rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/85"
                aria-label={`放大展示：${card.purpose}`}
                data-testid={`reply-big-${index}`}
                onClick={() => onShowBig(card)}
              >
                放大展示
              </button>
              <button
                type="button"
                className="rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/85"
                aria-label={`编辑这一句：${card.purpose}`}
                data-testid={`reply-edit-${index}`}
                onClick={() => setEditing({ id: card.id, value: card.en })}
              >
                编辑
              </button>
            </div>

            {editing?.id === card.id ? (
              <div className="mt-2">
                <label className="text-[11.5px] text-white/55" htmlFor={`reply-edit-input-${index}`}>
                  改完请自己核对意思；近音会按新句子重算
                </label>
                <textarea
                  id={`reply-edit-input-${index}`}
                  className="mt-1 w-full rounded-lg border border-white/15 bg-ink-950/80 px-2 py-1 text-[13px] text-white"
                  rows={2}
                  lang="en"
                  value={editing.value}
                  data-testid={`reply-edit-input-${index}`}
                  onChange={(event) => setEditing({ id: card.id, value: event.target.value })}
                />
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    className="rounded-lg bg-accent px-2.5 py-1 text-[12px] text-ink-950"
                    onClick={() => {
                      onEdit(card.id, editing.value);
                      setEditing(null);
                      setStatus('已保存你改的句子');
                    }}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/15 px-2.5 py-1 text-[12px] text-white/75"
                    onClick={() => setEditing(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {/* 短提示，role="status"：读屏会念一次，不抢焦点。 */}
      <p role="status" className="mt-2 text-[11.5px] text-white/45" data-testid="reply-status">
        {status}
      </p>
    </section>
  );
}
