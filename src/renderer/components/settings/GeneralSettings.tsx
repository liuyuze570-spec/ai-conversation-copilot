import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settings';
import { TONE_LABELS, TONE_ORDER } from '../../../services/tone';
import type { Settings } from '../../../shared/types';
import {
  SCENARIO_MODES,
  REPLY_STYLES,
  RESPONSE_LENGTHS,
  TARGET_LANGUAGES,
} from '../../../shared/types';
import { levelFor, levelsFor } from '../../../shared/levels';
import {
  ACCENTS,
  COMPREHENSION_LANGUAGES,
  HINT_SYSTEMS,
  IMPLEMENTED_DIRECTIONS,
  defaultHintSystem,
  directionStatus,
  hintSystemLabel,
  type ComprehensionLanguage,
  type HintSystem,
} from '../../../shared/languages';
import { WebSpeechTTS } from '../../../services/tts/web-speech';
import { SOURCE_MODE_OPTIONS, resolveSources, type SourceMode } from '../../../shared/sources';
import {
  FONT_MAX,
  FONT_MIN,
  ORIGINAL_FONT_DEFAULT,
  READING_MODES,
  ROMANIZATION_FONT_DEFAULT,
  TEXT_TOKENS,
  TRANSLATION_FONT_DEFAULT,
  clampFont,
  contrastOf,
  type ReadingMode,
} from '../../../shared/reading';
import type { HealthReport } from '../../../shared/health';
import { HealthView } from '../HealthView';
import {
  Button,
  DeviceSelect,
  Hint,
  Range,
  Row,
  Section,
  Select,
  TextInput,
  Toggle,
} from './controls';

/**
 * 「常用功能」标签页：跟模型 / Key 无关的所有日常开关。
 * 界面语言、场景、发音、字幕、窗口、音频设备、个人资料。
 */
export function GeneralSettings() {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<HealthReport | null>(null);

  const patch = (value: Partial<Settings>) => void update(value);

  /*
   * 这台机器到底有没有目标语言的声音。
   *
   * Windows 的语音列表是异步加载的（首帧常常是空数组），所以第一次读完之后
   * 再等 `voiceschanged` 更新一次。界面上直接写清「有 / 没有 / 还没加载好」，
   * 用户就不会在点朗读没反应时怀疑软件坏了。
   */
  const [voiceStatus, setVoiceStatus] = useState<{ ok: boolean; label: string }>({
    ok: true,
    label: '正在读取系统语音…',
  });
  const accent = settings.accent ?? 'en-US';
  useEffect(() => {
    const read = () => {
      try {
        const tts = new WebSpeechTTS();
        const all = tts.listVoices();
        const mine = tts.voicesFor(accent);
        if (!all.length) {
          setVoiceStatus({ ok: false, label: '系统语音列表还没加载出来（可稍后再看）' });
          return;
        }
        if (!mine.length) {
          /*
           * 说清「系统里到底有什么」。
           *
           * 只写「缺少 en-US 语音」用户没法判断是自己没装语言包，还是软件
           * 读错了清单。把现有语言列出来，他一看就知道下一步是去装语音包。
           */
          const langs = Array.from(new Set(all.map((voice) => voice.lang.split('-')[0])));
          const list = langs.slice(0, 4).join('、');
          setVoiceStatus({
            ok: false,
            label: `缺少 ${accent} 语音｜系统现有 ${langs.length} 种语言的声音（${list}${langs.length > 4 ? ' 等' : ''}），装一个对应语音包再回来看`,
          });
          return;
        }
        setVoiceStatus({
          ok: true,
          label: `${mine[0].name}｜${mine[0].lang}${mine.length > 1 ? `（共 ${mine.length} 个可选）` : ''}`,
        });

      } catch {
        setVoiceStatus({ ok: false, label: '读不到系统语音列表' });
      }
    };
    read();
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.addEventListener('voiceschanged', read);
      return () => window.speechSynthesis.removeEventListener('voiceschanged', read);
    }
    return undefined;
  }, [accent]);

  const targetLabel =
    TARGET_LANGUAGES.find((item) => item.value === settings.targetLanguage)?.label ?? '英语 English';
  const targetShort = targetLabel.split(' ')[0];
  const currentLevel = levelFor(settings.languageLevels, settings.targetLanguage);

  /* 音频段落要显示的「这次会采什么」——与主进程启动时用的是同一个纯函数，
     所以设置页显示的和实际跑的不会有两套说法。 */
  const plan = resolveSources({
    sourceMode: settings.audio.sourceMode,
    captureSystemAudio: settings.audio.captureSystemAudio,
    captureMicrophone: settings.audio.captureMicrophone,
  });

  /* 对比度现算：先做 alpha 合成再算比值，得到的就是屏幕上真正的那个颜色。 */
  const contrastNormal = contrastOf(
    TEXT_TOKENS.normal.translation.color,
    TEXT_TOKENS.normal.translation.alpha,
    TEXT_TOKENS.normal.background,
  );
  const contrastHigh = contrastOf(
    TEXT_TOKENS.high.translation.color,
    TEXT_TOKENS.high.translation.alpha,
    TEXT_TOKENS.high.background,
  );

  const runCheck = async () => {
    setChecking(true);
    try {
      setHealth(await window.copilot.systemCheck());
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Section title="语言">
        {/*
          「界面语言」和「你理解的语言」是两件事，所以分开写。
          本版界面只有简体中文 —— 这里如实标成一项不可选的信息，
          而不是放一个点了没反应的下拉框。
        */}
        <Row label="界面语言">
          <span data-ui-language className="text-[11px] text-white/45">
            简体中文（本版只有这一种）
          </span>
        </Row>
        <Row label="你理解的语言">
          <Select
            value={settings.nativeLanguage}
            options={COMPREHENSION_LANGUAGES.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
            dataAttr="data-native-select"
            onChange={(value) =>
              patch({
                nativeLanguage: value,
                // 换理解语言时，提示体系跟着换一个**合理的起点**（可以再改）。
                hintSystem: defaultHintSystem(
                  value as ComprehensionLanguage,
                  settings.targetLanguage,
                ),
              })
            }
          />
        </Row>
        <Row label="我想说的语言">
          <Select
            value={settings.targetLanguage}
            options={TARGET_LANGUAGES.map((item) => ({ value: item.value, label: item.label }))}
            dataAttr="data-target-select"
            onChange={(value) => {
              const next = value as Settings['targetLanguage'];
              patch({
                targetLanguage: next,
                accent: ACCENTS[next][0].value,
                // 目标语言变了，提示体系多半也要换（英语读者看日语要罗马字）。
                hintSystem: defaultHintSystem(
                  settings.nativeLanguage as ComprehensionLanguage,
                  next,
                ),
              });
            }}
          />
        </Row>
        <Row label="读音提示">
          <Select
            value={settings.hintSystem ?? 'hanzi'}
            options={HINT_SYSTEMS.map((item) => ({
              value: item.value,
              label: `${item.label}（${item.sample}）`,
            }))}
            dataAttr="data-hint-select"
            onChange={(value) => patch({ hintSystem: value as HintSystem })}
          />
        </Row>
        <Row label="口音 / 地区">
          <Select
            value={settings.accent ?? ACCENTS[settings.targetLanguage][0].value}
            options={ACCENTS[settings.targetLanguage]}
            dataAttr="data-accent-select"
            onChange={(value) => patch({ accent: value })}
          />
        </Row>
        <Hint>
          这三个是分开的：理解的语言决定译文和释义用什么话写；想说的语言决定你要开口说什么；
          读音提示决定用哪种字给你标近似音（汉字近音 / 片假名 / 罗马字）。
          换了提示方式只会换那行注音，不会改你要说的意思。
        </Hint>
        {/*
          大声说清楚「已实现」和「结构上支持」的区别。
          不写「支持全球语言」，也不写「准确率」。
        */}
        <div data-direction-status className="rounded-xl border border-line-soft bg-ink-850/60 px-2.5 py-2">
          <p className="text-[10.5px] leading-relaxed text-white/45">
            本版实测过的组合：
          </p>
          <ul className="mt-1 space-y-0.5">
            {IMPLEMENTED_DIRECTIONS.map((item) => (
              <li key={item.id} className="text-[10.5px] leading-relaxed text-white/55">
                {item.label}（{hintSystemLabel(item.hintSystem)}）
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] leading-relaxed text-white/30">
            其他组合可以在上面任选，但只做过结构验证，没有对应的人工核对样本 —— 界面上不把它们标成「已支持」。
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-white/30">
            当前组合：{settings.nativeLanguage} → {settings.targetLanguage}，
            {directionStatus({
              comprehension: settings.nativeLanguage as ComprehensionLanguage,
              target: settings.targetLanguage,
              hintSystem: (settings.hintSystem ?? 'hanzi') as HintSystem,
              accent: settings.accent ?? '',
            }) === 'verified'
              ? '在实测清单内'
              : '不在实测清单内（可用，但未核对）'}
          </p>
        </div>
        <Row label="朗读语音">
          <span data-voice-status data-voice-ok={voiceStatus.ok ? 'true' : 'false'} className="text-[11px] text-white/45">
            {voiceStatus.label}
          </span>
        </Row>
        <Hint>
          「{accent}」这套声音是系统自带的。没有安装对应语音包时，朗读会明确报错，
          不会静默改用别的语言去念 —— 那样听起来像是软件发音很差，其实是发错了语言。
        </Hint>
        <Row label={`语言水平（${targetShort}）`}>
          <Select
            value={currentLevel}
            options={levelsFor(settings.targetLanguage)}
            dataAttr="data-grade-select"
            onChange={(value) =>
              patch({
                // 每门语言各存一份：从日语切回英语，英语还是你原来选的那档。
                languageLevels: { ...settings.languageLevels, [settings.targetLanguage]: value },
              })
            }
          />
        </Row>
        <Hint>
          英语是「B 级 → 专业八级」，俄语是「入门 → 专业八级」，日语是 JLPT N5 → N1，韩语是
          TOPIK 1 → 6 级。AI 会照这个水平挑词：等级越低越好念，越高越地道。
        </Hint>
        <Row label="回复长度">
          <Select
            value={settings.responseLength}
            options={RESPONSE_LENGTHS}
            dataAttr="data-length-select"
            onChange={(value) => patch({ responseLength: value as Settings['responseLength'] })}
          />
        </Row>
        <Row label="回复风格">
          <Select
            value={settings.replyStyle}
            options={REPLY_STYLES}
            dataAttr="data-reply-style"
            onChange={(value) => patch({ replyStyle: value as Settings['replyStyle'] })}
          />
        </Row>
        <Hint>
          回复风格决定 AI 帮你想的那句话怎么说。选「幽默」会轻松开玩笑，「正式」适合面试 / 商务，
          「简单」用最好念的词。选完之后 AI 必须按这个风格写，不会自己换一种；换完下一句回复立刻生效。
        </Hint>
        <Row label="语气 / 情绪">
          <Select
            value={settings.tone}
            options={TONE_ORDER.map((key) => ({ value: key, label: TONE_LABELS[key] }))}
            onChange={(value) => patch({ tone: value as Settings['tone'] })}
          />
        </Row>
        <Hint dataAttr="data-tone-hint">
          选了具体情绪（开心 / 难过 / 期待…），三条回复都必须按这个情绪说，不会被对话内容带偏；
          选「自动」时由 AI 看对方最后说的话判断，对方开心它就开心，对方低落它就轻声些。
          强烈情绪只针对事情，不针对人，也不会出现脏话与侮辱。
        </Hint>
      </Section>

      <Section title="场景">
        <Row label="当前场景">
          <Select
            value={settings.scenarioMode}
            options={SCENARIO_MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
            onChange={(value) => patch({ scenarioMode: value as Settings['scenarioMode'] })}
          />
        </Row>
        <Hint>{SCENARIO_MODES.find((mode) => mode.value === settings.scenarioMode)?.hint}</Hint>
        <Toggle
          label="停顿自动生成回复"
          value={settings.autoReplyOnPause}
          onChange={(value) => patch({ autoReplyOnPause: value })}
        />
        <Range
          label="停顿判定"
          value={settings.pauseDetectMs}
          min={1000}
          max={6000}
          step={250}
          format={(value) => `${(value / 1000).toFixed(1)}s`}
          onChange={(value) => patch({ pauseDetectMs: value })}
        />
        <Hint>
          看视频 / 四六级听力时：对方说的每一句都会实时翻译；对方停下来（或你暂停视频）
          超过上面的秒数，就自动生成可以回应的内容。
        </Hint>
      </Section>

      <Section title="发音辅助">
        <Toggle
          label="IPA 音标"
          value={settings.pronunciation.ipa}
          onChange={(value) => patch({ pronunciation: { ...settings.pronunciation, ipa: value } })}
        />
        <Toggle
          label="音节拆分"
          value={settings.pronunciation.syllables}
          onChange={(value) =>
            patch({ pronunciation: { ...settings.pronunciation, syllables: value } })
          }
        />
        <Toggle
          label="中文近似音"
          value={settings.pronunciation.chinesePronunciation}
          onChange={(value) =>
            patch({ pronunciation: { ...settings.pronunciation, chinesePronunciation: value } })
          }
        />
        <Hint>中文发音仅为近似辅助，建议以 IPA / 语音朗读为准。</Hint>
      </Section>

      <Section title="字幕（主要阅读区）">
        {/*
          * 三类文字三个独立滑块：原文 / 译文 / 中文谐音。
          *
          * 旧版只有一个「字号」，译文在这个值上再减 2px、谐音再减 3px ——
          * 想看清中文就必须把原文一起放大，原文一放大，一屏能看的句子就少
          * 一半；想跟着谐音念，又把三行全推大。三件事的诉求本来就不同。
          * 范围统一 12–64px，改一个绝不动另外两个。
          */}
        <Range
          label="外语原文字号"
          value={clampFont(settings.subtitle.originalFontSize)}
          min={FONT_MIN}
          max={FONT_MAX}
          format={(value) => `${value}px`}
          onChange={(value) =>
            patch({ subtitle: { ...settings.subtitle, originalFontSize: clampFont(value) } })
          }
        />
        <Range
          label="中文译文字号"
          value={clampFont(settings.subtitle.translationFontSize)}
          min={FONT_MIN}
          max={FONT_MAX}
          format={(value) => `${value}px`}
          onChange={(value) =>
            patch({ subtitle: { ...settings.subtitle, translationFontSize: clampFont(value) } })
          }
        />
        <Range
          label="中文近似音字号"
          value={clampFont(settings.subtitle.romanizationFontSize)}
          min={FONT_MIN}
          max={FONT_MAX}
          format={(value) => `${value}px`}
          onChange={(value) =>
            patch({ subtitle: { ...settings.subtitle, romanizationFontSize: clampFont(value) } })
          }
        />
        <Hint>
          中文近似音是给外语标的谐音（例如把 “How are you” 标成「好 阿 优」），
          只帮助回忆读音，不等同于准确发音；要准确读音请用音标或朗读。
          三行字号互不影响，首页顶部「原文 / 译文 / 谐音」也能随时调。
        </Hint>
        <button
          type="button"
          data-font-reset
          onClick={() =>
            patch({
              subtitle: {
                ...settings.subtitle,
                originalFontSize: ORIGINAL_FONT_DEFAULT,
                translationFontSize: TRANSLATION_FONT_DEFAULT,
                romanizationFontSize: ROMANIZATION_FONT_DEFAULT,
              },
            })
          }
          className="no-drag rounded-md border border-line px-2 py-1 text-[10.5px] text-white/55
            transition-colors hover:bg-ink-800 hover:text-white"
        >
          恢复默认字号（原文 {ORIGINAL_FONT_DEFAULT} / 译文 {TRANSLATION_FONT_DEFAULT} / 谐音{' '}
          {ROMANIZATION_FONT_DEFAULT}）
        </button>
        <Row label="阅读方式">
          <Select
            value={settings.subtitle.readingMode}
            options={READING_MODES.map((item) => ({ value: item.value, label: item.label }))}
            dataAttr="data-reading-mode-select"
            onChange={(value) =>
              patch({ subtitle: { ...settings.subtitle, readingMode: value as ReadingMode } })
            }
          />
        </Row>
        <Hint>
          {READING_MODES.find((item) => item.value === settings.subtitle.readingMode)?.hint}
          。字号加减和高对比在首页顶部就能调，不必进设置。
        </Hint>
        <Toggle
          label="高对比（纯白字 + 纯黑底）"
          value={settings.subtitle.highContrast}
          onChange={(value) => patch({ subtitle: { ...settings.subtitle, highContrast: value } })}
        />
        {/*
          * 对比度写计算值，不写「已符合无障碍标准」。
          * 这两个数字由 contrastOf() 现算（先把半透明合成到底色上再算比值），
          * 和界面上真正显示的颜色用的是同一份取色表。
          * 说明：这是**按配色表计算**的结果，不是测量仪器读数；高对比模式下
          * 底色真的是 #000、文字真的是 #fff（见 styles.css 的 [data-contrast]）。
          */}
        <p data-contrast-figures className="mt-1 font-mono text-[10.5px] leading-relaxed text-white/45">
          译文对比度：{contrastNormal.toFixed(1)}:1（普通）· {contrastHigh.toFixed(1)}:1（高对比）
          <span className="ml-1 text-white/30">WCAG 正文要求 ≥ 4.5:1，大字号要求 ≥ 3:1</span>
        </p>
        <Range
          label="可上翻历史"
          value={settings.subtitle.maxItems}
          min={20}
          max={500}
          step={20}
          format={(value) => `${value} 条`}
          onChange={(value) => patch({ subtitle: { ...settings.subtitle, maxItems: value } })}
        />
        <Hint>
          这里只是「屏幕上同时保留多少条」。记录文件里一条都不会删 ——
          历史不受这个数字限制，见「记录」面板。
        </Hint>
        <Toggle
          label="显示中文翻译"
          value={settings.subtitle.showTranslation}
          onChange={(value) =>
            patch({ subtitle: { ...settings.subtitle, showTranslation: value } })
          }
        />
        <Toggle
          label="低置信度提示"
          value={settings.subtitle.showConfidenceWarning}
          onChange={(value) =>
            patch({ subtitle: { ...settings.subtitle, showConfidenceWarning: value } })
          }
        />
      </Section>

      <Section title="重点信息">
        <Toggle
          label="提取关键事实"
          value={settings.facts.enabled}
          onChange={(value) => patch({ facts: { ...settings.facts, enabled: value } })}
        />
        <Toggle
          label="用模型补人名、事项"
          value={settings.facts.useModel}
          onChange={(value) => patch({ facts: { ...settings.facts, useModel: value } })}
        />
        <Hint>
          时间、日期、金额、数量在本机用规则认，不联网、不花钱；人名、机构、待办、
          负责人交给你在「API 功能」里选的那家国内服务商。关掉第二项就只保留本地规则。
          这些卡片只存在当前会话的内存里，清空对话或关掉软件就没了。
        </Hint>
      </Section>

      <Section title="窗口">
        <Range
          label="不透明度"
          value={Math.round(settings.window.opacity * 100)}
          min={35}
          max={100}
          format={(value) => `${value}%`}
          onChange={(value) => {
            const opacity = value / 100;
            patch({ window: { ...settings.window, opacity } });
            window.copilot.setOpacity(opacity);
          }}
        />
        <Toggle
          label="始终置顶"
          value={settings.window.alwaysOnTop}
          onChange={(value) => {
            patch({ window: { ...settings.window, alwaysOnTop: value } });
            window.copilot.setAlwaysOnTop(value);
          }}
        />
        <Row label="界面模式">
          <Select
            value={settings.uiMode}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'advanced', label: '完整' },
            ]}
            onChange={(value) => patch({ uiMode: value as Settings['uiMode'] })}
          />
        </Row>
        <div className="mt-1">
          <Button full onClick={() => window.copilot.resetWindowPosition()}>
            重置窗口位置（找不到窗口时用）
          </Button>
        </div>
      </Section>

      <Section title="音频（听谁的）">
        {/*
          * 先问「这是哪种场合」，再问设备。
          *
          * 顺序反了就会出错：旧版一上来就是「系统声音 / 麦克风」两个开关，
          * 而麦克风在两种场合下收到的**不是同一个人** —— 线上会议里是自己，
          * 面对面时是对方。用户只能靠猜，猜错了就得到一堆不翻译的字幕。
          */}
        <Row label="音源用途">
          <Select
            value={settings.audio.sourceMode}
            options={SOURCE_MODE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
            dataAttr="data-source-mode-select"
            onChange={(value) => patch({ audio: { ...settings.audio, sourceMode: value as SourceMode } })}
          />
        </Row>

        {/* 选完立刻回读一遍「所以这次会采什么、翻不翻」，不让人靠记忆核对。 */}
        <div
          data-source-plan
          className="mt-1 rounded-lg border border-line-soft bg-ink-850 px-2 py-1.5 text-[11px] leading-relaxed text-white/60"
        >
          {plan.items.length ? (
            plan.items.map((item) => (
              <p key={item.channel}>
                <span className="text-white/80">{item.label}</span> · {item.purpose}
                <span className={item.translate ? ' text-ok/80' : ' text-white/35'}>
                  {item.translate ? '（会翻译）' : '（不翻译）'}
                </span>
              </p>
            ))
          ) : (
            <p className="text-warn/85">这次没有可用的音源，采不到任何声音。</p>
          )}
          {plan.warning && (
            <p data-source-warning className="mt-1 text-warn/85">
              {plan.warning}
            </p>
          )}
        </div>

        <Row label="系统声音设备">
          <DeviceSelect
            kind="system"
            value={settings.audio.systemDeviceId}
            onChange={(value) => patch({ audio: { ...settings.audio, systemDeviceId: value } })}
          />
        </Row>
        <Row label="麦克风设备">
          <DeviceSelect
            kind="mic"
            value={settings.audio.micDeviceId}
            onChange={(value) => patch({ audio: { ...settings.audio, micDeviceId: value } })}
          />
        </Row>
        <Toggle
          label="捕获系统声音（对方在电脑里说话）"
          value={settings.audio.captureSystemAudio}
          onChange={(value) => patch({ audio: { ...settings.audio, captureSystemAudio: value } })}
        />
        <Toggle
          /* 标签跟着音源用途走：同一个麦克风，两种场合收到的是两个人。 */
          label={
            settings.audio.sourceMode === 'onsite'
              ? '捕获麦克风（对方在旁边说话）'
              : '捕获麦克风（你自己说话）'
          }
          value={settings.audio.captureMicrophone}
          onChange={(value) => patch({ audio: { ...settings.audio, captureMicrophone: value } })}
        />
        <Hint>
          线上交流：电脑里播放的声音是对方，会出原文和中文译文；麦克风只做口语提示，不翻译。
          现场沟通：麦克风收到的是对方，会出原文和中文译文；这时系统声音会让位，
          免得同一句话出两遍字幕。
        </Hint>
        <Toggle
          label="口语纠错提示"
          value={settings.speakingCorrection}
          onChange={(value) => patch({ speakingCorrection: value })}
        />
        <Range
          label="静音判定"
          value={settings.audio.vadSilenceMs}
          min={300}
          max={2200}
          step={100}
          format={(value) => `${value}ms`}
          onChange={(value) => patch({ audio: { ...settings.audio, vadSilenceMs: value } })}
        />
        <Hint>
          停顿超过这个时长就算「一句话说完了」，送去识别一次。字幕被切得太碎、
          翻译跟不上时，把它往大调（1200–1600ms）；想更快出字幕就往小调。
        </Hint>
        <Range
          label="灵敏度"
          value={settings.audio.sensitivity ?? 1}
          min={1}
          max={4}
          step={0.2}
          format={(value) => `${value.toFixed(1)}x`}
          onChange={(value) => patch({ audio: { ...settings.audio, sensitivity: value } })}
        />
        <Hint>
          电影对白偏轻、笔记本扬声器音量小时，把<strong className="text-white/50">灵敏度</strong>
          调高（2–3x）能明显改善「听得到但识别不出」。增益是自适应的，音量再大也不会削顶失真。
        </Hint>

        <div className="mt-1.5 rounded-lg border border-line-soft bg-ink-850 px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-white/60">听不到声音？让它自己查一遍</span>
            <Button
              variant="primary"
              disabled={checking}
              dataAttr="data-health-run-settings"
              onClick={() => void runCheck()}
            >
              {checking ? '检查中…' : '一键诊断'}
            </Button>
          </div>
          {/* 没点按钮之前只说会查什么，不摆任何结果 —— 一片全绿的技术参数对用户
              没有意义，只有「哪一项挡着出字幕」才有意义。 */}
          {health ? (
            <div className="mt-1.5">
              <HealthView report={health} />
            </div>
          ) : (
            <Hint>
              会自己检查音频组件、默认扬声器、采集开关、识别 Key 和模型，只把有问题的
              地方列出来。检查期间请让电影 / 音乐正常播放。
            </Hint>
          )}
        </div>
      </Section>

      <Section title="我的资料（可选）">
        <Row label="名字">
          <TextInput
            value={settings.profile.name}
            onChange={(value) => patch({ profile: { ...settings.profile, name: value } })}
          />
        </Row>
        <Row label="城市">
          <TextInput
            value={settings.profile.city}
            onChange={(value) => patch({ profile: { ...settings.profile, city: value } })}
          />
        </Row>
        <Row label="兴趣">
          <TextInput
            value={settings.profile.interests}
            onChange={(value) => patch({ profile: { ...settings.profile, interests: value } })}
          />
        </Row>
        <Hint>填了之后 AI 帮回复会更贴合你的情况（比如提到你所在城市的事）。</Hint>
      </Section>
    </>
  );
}
