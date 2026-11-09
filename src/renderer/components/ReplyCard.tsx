import { useState } from 'react';
import type { ReplySuggestion } from '../../shared/types';
import { ShowCard } from './ShowCard';
import type { PronunciationSettings, ScenarioMode } from '../../shared/types';
import { readingPrefs } from '../../shared/reading';
import { useSettingsStore } from '../stores/settings';
import { IconSpeaker } from './icons';
import type { CopilotMode } from '../hooks/useCopilot';

interface Props {
  suggestion: ReplySuggestion;
  pronunciation: PronunciationSettings;
  /** What is being listened to — changes what each card is labelled. */
  scenario: ScenarioMode;
  speaking: boolean;
  onSpeak: () => void;
  /** Replay at a slower rate so the user can read along while practising. */
  onSpeakSlow: () => void;
  /** 短语重复：一段一段地念，中间留一口气。 */
  onSpeakPhrases: () => void;
  onRefine: (mode: CopilotMode) => void;
}

/** Same three cards, but their meaning depends on what you are listening to. */
const KIND_LABEL: Record<ScenarioMode, Record<ReplySuggestion['kind'], string>> = {
  conversation: { simple: '简单回答', natural: '自然聊天', continue: '延续话题' },
  video: { simple: '简单反应', natural: '自然回应', continue: '追问一句' },
  exam: { simple: '关键要点', natural: '参考答案', continue: '拓展表达' },
};

/**
 * 卡片按「用途」分色，而不是按顺序。
 *
 * 颜色只作为识别锚点（标签底色 + 左侧细轨），不铺满卡片 —— 三张卡同时出现时
 * 才不会变成调色盘。
 */
const KIND_TONE: Record<ReplySuggestion['kind'], { chip: string; rail: string }> = {
  simple: { chip: 'bg-ok/12 text-ok/90', rail: 'bg-ok/45' },
  natural: { chip: 'bg-accent/15 text-accent-soft/90', rail: 'bg-accent/50' },
  continue: { chip: 'bg-warn/12 text-warn/85', rail: 'bg-warn/45' },
};

export function ReplyCard({
  suggestion,
  pronunciation,
  scenario,
  speaking,
  onSpeak,
  onSpeakSlow,
  onSpeakPhrases,
  onRefine,
}: Props) {
  const showHint = pronunciation.readingHint ?? pronunciation.chinesePronunciation;
  /*
   * 提示字段两代并存：新的是 `readingHint`（字系由 hintSystem 决定），
   * 旧的是 `chinesePronunciation`（汉字近音）。历史记录里存的是旧的，
   * 所以两个都读。
   */
  const hint = suggestion.readingHint ?? suggestion.chinesePronunciation ?? '';
  const hintSystem = suggestion.hintSystem ?? 'hanzi';
  const meaning = suggestion.meaning ?? suggestion.chinese;
  const hasPron =
    (showHint && Boolean(hint)) ||
    (pronunciation.syllables && suggestion.syllables?.length) ||
    (pronunciation.syllables && suggestion.romanization) ||
    (pronunciation.ipa && suggestion.ipa);

  const tone = KIND_TONE[suggestion.kind];

  /*
   * 回复卡片里的中文谐音也要跟着「谐音字号」走。
   *
   * 它和字幕里的谐音是同一类内容，用户把谐音调大是为了跟着念 ——
   * 卡片里却还是 13.5px 小字，等于调了没用。
   */
  const subtitle = useSettingsStore((state) => state.settings.subtitle);
  const romanizationFontSize = readingPrefs(subtitle).romanizationFontSize;

  /** 双面沟通卡：把自己这面 / 给对方那面分开显示。 */
  const [showCard, setShowCard] = useState(false);

  return (
    <div
      data-reply-card
      className="animate-fade-in-up relative overflow-hidden rounded-2xl border border-line-soft
        bg-ink-800/70 pl-3 pr-3 py-2.5 transition-colors duration-200 hover:border-line"
    >
      {/* 左侧细轨：一眼分清「简单反应 / 自然回应 / 追问一句」。 */}
      <span className={`absolute inset-y-2 left-0 w-[2px] rounded-full ${tone.rail}`} />

      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className={`chip ${tone.chip}`}>{KIND_LABEL[scenario][suggestion.kind]}</span>
        {/*
          * 0.6.3：操作按钮放大到 32px、间距拉开。
          * 旧版「播放 / 0.7x / 分句 / 给对方看」挤在标题行右侧，只有 24px 高、
          * 10px 小字 —— 听障使用者常要反复点这几个键（念一遍、慢速跟一遍），
          * 太小根本点不准。现在把「给对方看」挪到正文下方单独一行，标题行
          * 只留三个读音键，全部加到 32px 可点区域。
          */}
        <div className="no-drag flex shrink-0 items-center gap-1">
          <button
            onClick={onSpeak}
            title="播放发音"
            className={`grid h-8 w-8 place-items-center rounded-lg transition-colors duration-150
              ${speaking ? 'bg-accent/25 text-accent-soft' : 'text-white/55 hover:bg-ink-700 hover:text-white'}`}
          >
            <IconSpeaker size={16} />
          </button>
          <button
            onClick={onSpeakSlow}
            title="慢速播放（0.7x），方便跟着念"
            className="grid h-8 place-items-center rounded-lg px-2 text-[12px] font-medium text-white/55
              transition-colors duration-150 hover:bg-ink-700 hover:text-white"
          >
            0.7x
          </button>
          <button
            onClick={onSpeakPhrases}
            data-speak-phrases
            title="短语重复：按真实分块一段一段念，每段之间停一下"
            className="grid h-8 place-items-center rounded-lg px-2 text-[12px] font-medium text-white/55
              transition-colors duration-150 hover:bg-ink-700 hover:text-white"
          >
            分句
          </button>
        </div>
      </div>

      <p className="text-[14.5px] font-medium leading-snug tracking-[0.005em] text-white/[0.95]">
        {suggestion.english}
      </p>
      {/*
        释义的语言跟着「使用者理解的语言」走，可能是中文、日文或英文 ——
        所以标签不写「中文」，只写一个字重更轻的说明。
      */}
      <p data-reply-meaning className="mt-1 text-[12px] leading-snug text-white/50">
        {meaning}
      </p>

      {/* The sound hint is what the user actually reads out loud — give it the
          strongest visual weight after the sentence itself. */}
      {hasPron && (
        <div
          data-pron-block
          className="mt-2 rounded-xl border border-accent/15 bg-accent/[0.06] px-2.5 py-1.5"
        >
          {showHint && hint ? (
            // data-pron-chinese：自检要断言这一行是「干净的中文谐音」——
            // 曾经出现模型把中文拼音/注音塞进来（实测 `太 ɡe 棒 了 我 ɑm…`）。
            <div className="flex items-baseline gap-1.5">
              <p
                data-pron-chinese
                data-hint-system={hintSystem}
                className="font-medium leading-snug tracking-[0.02em] text-accent-soft"
                style={{ fontSize: `${romanizationFontSize}px` }}
              >
                {hint}
              </p>
              {/*
                标签写清这是**哪种字系**的近似音。
                换了理解语言之后，用户不该看到一行没有说明、却换了字系的注音。
              */}
              <span className="shrink-0 text-[9.5px] text-white/30">
                {hintSystem === 'katakana' ? '片假名近似' : hintSystem === 'romaji' ? '罗马字' : '汉字近似'}
              </span>
              {suggestion.hintStatus === 'partial' && (
                <span
                  data-pron-partial
                  className="shrink-0 text-[9.5px] text-warn"
                  title="有词的读音没有可靠来源，没有编造"
                >
                  部分待核对
                </span>
              )}
              {suggestion.hintStatus === 'approx' && (
                <span
                  data-pron-approx
                  className="shrink-0 text-[9.5px] text-white/45"
                  title="这行是按规则拼出来的近似读法（词典没收录的词、人名或缩写），没有人工核对；念不准可以自己改。"
                >
                  规则近似
                </span>
              )}
            </div>
          ) : null}

          {(pronunciation.syllables && suggestion.syllables?.length) ||
          (pronunciation.syllables && suggestion.romanization) ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-[2px]">
              {pronunciation.syllables && suggestion.romanization ? (
                <span className="font-mono text-[10.5px] text-white/45">
                  {suggestion.romanization}
                </span>
              ) : null}
              {pronunciation.syllables && suggestion.syllables?.length ? (
                <span className="text-[10.5px] text-white/30">
                  {suggestion.syllables.join(' · ')}
                </span>
              ) : null}
            </div>
          ) : null}

          {pronunciation.ipa && suggestion.ipa ? (
            <p data-pron-ipa className="mt-[3px] font-mono text-[10.5px] text-white/30">
              {suggestion.ipa}
            </p>
          ) : null}
        </div>
      )}

      {showCard && (
        <ShowCard
          english={suggestion.english}
          meaning={meaning}
          hint={showHint ? hint : ''}
          hintSystem={hintSystem as 'hanzi' | 'katakana' | 'romaji' | 'none'}
          onSpeak={(_text, speed) => (speed ? onSpeakSlow() : onSpeak())}
          onClose={() => setShowCard(false)}
        />
      )}

      {/*
        * 0.6.3：底部操作区。把「给对方看」从标题行右侧挪到这里，做成一个
        * 整宽、34px 高的独立按钮 —— 这是听障使用者最常点的「把大字原文翻给
        * 对方看」，不该藏在标题行右侧的小字里。细化按钮也放大到 30px 可点
        * 区域、字号 12px。
        */}
      <button
        onClick={() => setShowCard(true)}
        data-reply-show
        title="打开双面卡：给对方看大字原文，自己这面看释义和读音提示"
        className="no-drag mt-2 flex h-[34px] w-full items-center justify-center gap-1.5 rounded-lg
          border border-accent/30 bg-accent/10 text-[12.5px] font-medium text-accent-soft
          transition-colors duration-150 hover:bg-accent/20 hover:text-accent-soft"
      >
        给对方看大字原文
      </button>

      <div className="mt-1.5 flex gap-1.5">
        <MiniButton onClick={() => onRefine('simplify')}>简单一点</MiniButton>
        <MiniButton onClick={() => onRefine('rephrase')}>换一种说法</MiniButton>
        <MiniButton onClick={() => onRefine('natural')}>更自然</MiniButton>
      </div>
    </div>
  );
}

function MiniButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="no-drag flex-1 rounded-lg border border-line-soft px-1 py-2 text-[12px] text-white/60
        transition-colors duration-150 hover:border-line hover:bg-ink-800 hover:text-white/90"
    >
      {children}
    </button>
  );
}
