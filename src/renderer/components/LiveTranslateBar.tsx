import { SCENARIO_MODES, type ScenarioMode } from '../../shared/types';
import { useConversationStore } from '../stores/conversation';
import { useSettingsStore } from '../stores/settings';
import { useUiStore } from '../stores/ui';

/**
 * The "live subtitle" for video / exam mode.
 *
 * In a two-way conversation you mostly care about what YOU should say, so the
 * scrolling transcript is the right centrepiece. When watching a video you
 * care about understanding what was just said, so this bar keeps the latest
 * foreign line plus its translation pinned in large, readable type — and
 * shows whether the video is still running or paused (a pause means a reply is
 * being drafted).
 *
 * 多轮语义：这里同时是「我在听第几轮」的唯一指示。用户反馈「无法开启第二轮
 * 对话监听」，很大一部分是**看不出来**还在听 —— 所以轮次、播放状态、以及
 * 「正在识别」三个信息必须同时可见。
 */
export function LiveTranslateBar({ scenario }: { scenario: ScenarioMode }) {
  const subtitle = useSettingsStore((state) => state.settings.subtitle);
  const playback = useUiStore((state) => state.playback);
  const roundIndex = useConversationStore((state) => state.roundIndex);
  const item = useConversationStore((state) => {
    for (let index = state.items.length - 1; index >= 0; index -= 1) {
      if (state.items[index].speaker === 'foreign') return state.items[index];
    }
    return null;
  });

  const mode = SCENARIO_MODES.find((entry) => entry.value === scenario);
  const paused = playback === 'paused';

  return (
    <div
      data-live-translate
      className="border-b border-line-soft bg-accent/[0.05] px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="label truncate !text-accent-soft/75">
            实时翻译 · {mode?.label ?? '看视频'}
          </span>
          {roundIndex > 0 && (
            <span
              data-live-round
              className="tnum shrink-0 rounded-full bg-ink-700 px-1.5 py-[1px] text-[9.5px] text-white/50"
            >
              第 {roundIndex} 轮
            </span>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-[2px] text-[9.5px] font-medium ${
            paused ? 'bg-warn/15 text-warn' : 'bg-ok/15 text-ok'
          }`}
        >
          {paused ? '已暂停 · 生成回复中' : '播放中'}
        </span>
      </div>

      {item ? (
        <>
          <p
            data-live-original
            className="mt-1 leading-snug text-white/[0.93]"
            style={{ fontSize: `${subtitle.fontSize}px` }}
          >
            {item.originalText}
            {item.partial ? <span className="text-white/25"> …</span> : null}
          </p>
          {subtitle.showTranslation && (
            <p
              data-live-translated
              className="mt-1 font-medium leading-snug text-accent-soft"
              style={{ fontSize: `${subtitle.fontSize + 1}px` }}
            >
              {item.translatedText ?? '翻译中…'}
            </p>
          )}
        </>
      ) : (
        <p className="mt-1 text-[11.5px] leading-relaxed text-white/30">
          {mode?.hint ?? '开始播放后，这里会实时翻译对方说的每一句。'}
        </p>
      )}
    </div>
  );
}
