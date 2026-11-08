/**
 * Shared domain types used by BOTH the Electron main process and the React renderer.
 * Keep this file dependency-free (no node / no electron imports).
 */

export type Speaker = 'foreign' | 'user';

import type { TranslationState } from './subtitle-state';
import type { ReadingMode } from './reading';
import type { SourceMode } from './sources';
import type { HintSystem } from './languages';
import type { HistoryField } from './history';
import type { CustomReading } from './reading-dictionary';

export type { ReadingMode };
export type { SourceMode };

/**
 * 语言水平。
 *
 * 以前这里用的是 CEFR 的 A1 / A2 / B1 / B2 / C1 —— 那是欧洲那套标准，而中国
 * 用户几乎只在驾照上见过「A1 / C1」这种写法，第一反应就是「这跟驾照一样吗」。
 * 换成国内真正在用的英语考试等级：B 级 / A 级 / 四级 / 六级 / 专四 / 专八。
 * 内部仍然按「六级比四级难」的顺序给模型写提示词，只是界面不再出现字母。
 */
export type EnglishGrade = 'pretcoB' | 'pretcoA' | 'cet4' | 'cet6' | 'tem4' | 'tem8';

export const ENGLISH_GRADES: { value: EnglishGrade; label: string; hint: string }[] = [
  { value: 'pretcoB', label: '英语 B 级', hint: '能听懂最简单的日常句子，词汇量不大' },
  { value: 'pretcoA', label: '英语 A 级', hint: '日常交流基本够用，能接上一两句' },
  { value: 'cet4', label: '大学英语四级', hint: '能听懂常见日常话题，多数人的水平' },
  { value: 'cet6', label: '大学英语六级', hint: '能听懂较复杂的话题，语速稍快也行' },
  { value: 'tem4', label: '英语专业四级', hint: '英语专业基础水平，听得懂地道表达' },
  { value: 'tem8', label: '英语专业八级', hint: '接近母语者，俚语、口音都能跟上' },
];

export function englishGradeLabel(value: string): string {
  return ENGLISH_GRADES.find((item) => item.value === value)?.label ?? '大学英语四级';
}

export type ResponseLength = 'short' | 'normal' | 'detailed';

export type ReplyStyle = 'simple' | 'natural' | 'friendly' | 'funny' | 'formal';

export type UiMode = 'compact' | 'advanced';

export type AssistanceLevel = 'high' | 'medium' | 'low';

/** Languages the copilot can help you speak (translated back into Chinese). */
export type TargetLanguage = 'English' | 'Russian' | 'Japanese' | 'Korean';

export const TARGET_LANGUAGES: { value: TargetLanguage; label: string }[] = [
  { value: 'English', label: '英语 English' },
  { value: 'Russian', label: '俄语 Русский' },
  { value: 'Japanese', label: '日语 日本語' },
  { value: 'Korean', label: '韩语 한국어' },
];

/**
 * 母语：外语被翻译成哪种语言给你看。
 *
 * 以前这里是个自由文本输入框，默认值写死成英文单词 "Chinese"，新手既不知道
 * 该填什么、也不知道填错会不会出问题。改成下拉，默认「中文（简体）」。
 */
export const NATIVE_LANGUAGES: { value: string; label: string }[] = [
  { value: 'Chinese', label: '中文（简体）' },
  { value: 'English', label: '英语 English' },
  { value: 'Russian', label: '俄语 Русский' },
  { value: 'Japanese', label: '日语 日本語' },
  { value: 'Korean', label: '韩语 한국어' },
];

/**
 * 回复风格：决定 AI 帮你想出来的那句话「怎么说」。
 *
 * 每一项都带一句中文说明——原来下拉里只有 simple / natural / friendly 这种
 * 英文单词，用户根本分不清哪个是哪个。
 */
export const REPLY_STYLES: { value: ReplyStyle; label: string; hint: string }[] = [
  { value: 'natural', label: '自然', hint: '像真人在视频电话里随口聊' },
  { value: 'simple', label: '简单', hint: '用最简单的词，好念、对方好懂' },
  { value: 'friendly', label: '热情', hint: '语气温暖，带点情绪' },
  { value: 'funny', label: '幽默', hint: '轻松开个玩笑，不失礼' },
  { value: 'formal', label: '正式', hint: '礼貌、专业（面试 / 商务）' },
];

/** 回复长度。 */
export const RESPONSE_LENGTHS: { value: ResponseLength; label: string; hint: string }[] = [
  { value: 'short', label: '短', hint: '能答上就行，一两句' },
  { value: 'normal', label: '适中', hint: '两到三句，像正常聊天' },
  { value: 'detailed', label: '详细', hint: '多补一句背景，方便你学' },
];

/** BCP-47 tags used by Web Speech / TTS providers. */
export const LANGUAGE_TAGS: Record<TargetLanguage, string> = {
  English: 'en-US',
  Russian: 'ru-RU',
  Japanese: 'ja-JP',
  Korean: 'ko-KR',
};

/**
 * ISO-639-1 codes passed to speech-to-text endpoints.
 * Sending the wrong one makes Whisper "translate" Russian into English.
 */
export const LANGUAGE_STT_CODES: Record<TargetLanguage, string> = {
  English: 'en',
  Russian: 'ru',
  Japanese: 'ja',
  Korean: 'ko',
};

export function sttLanguageCode(language: TargetLanguage): string {
  return LANGUAGE_STT_CODES[language] ?? 'en';
}

/**
 * What the copilot is actually listening to.
 *
 * - `conversation` — a live two-way chat. Replies are generated on demand.
 * - `video` — a movie / stream / any playing video. Everything the other side
 *   says is translated live, and when the video is paused (they stop talking)
 *   the copilot generates a reply the user could say or post.
 * - `exam` — CET-4/6 (四六级) listening practice. Same live translation and
 *   pause-to-answer flow, but the suggestions are framed as the key point of
 *   the listening plus a model answer a candidate could actually say.
 */
export type ScenarioMode = 'conversation' | 'video' | 'exam';

export const SCENARIO_MODES: {
  value: ScenarioMode;
  label: string;
  short: string;
  hint: string;
}[] = [
  {
    value: 'conversation',
    label: '实时对话',
    short: '对话',
    hint: '一问一答，需要时再生成回复',
  },
  {
    value: 'video',
    label: '看视频 / 影视',
    short: '看视频',
    hint: '实时翻译对方说的每一句；视频暂停时自动生成回应',
  },
  {
    value: 'exam',
    label: '四六级听力',
    short: '四六级',
    hint: '听力实时翻译；暂停时给出关键要点与参考答案',
  },
];

export function scenarioLabel(value: ScenarioMode): string {
  return SCENARIO_MODES.find((item) => item.value === value)?.label ?? '实时对话';
}

/**
 * Emotional tone the user wants to speak with. `auto` lets the copilot pick
 * whatever fits the conversation; the rest force a specific mood so the
 * suggestions actually sound happy / sad / disappointed / excited / angry...
 */
export type ToneKey =
  | 'auto'
  | 'happy'
  | 'sad'
  | 'disappointed'
  | 'excited'
  | 'angry'
  | 'grateful'
  | 'playful'
  | 'anxious'
  | 'rant';

/** A single recognized utterance in the conversation buffer. */
export interface ConversationItem {
  id: string;
  timestamp: number;
  speaker: Speaker;
  /** Original (target language, usually English) text. */
  originalText: string;
  /** Native language translation (usually Chinese). */
  translatedText?: string;
  /**
   * 译文当前处于哪一步。界面据此区分「翻译中 / 翻译失败 / 已停止翻译」，
   * 失败与取消还会给一个逐句重试入口。判定见 `shared/subtitle-state.ts`。
   */
  translationState?: TranslationState;
  /** STT confidence 0..1 */
  confidence?: number;
  /** True while the sentence is still streaming (not finalized). */
  partial?: boolean;
  /**
   * 这一句翻译失败的结构化原因。
   *
   * 以前失败时跨进程只回来一个空字符串，界面只能写「翻译失败」，用户不知道
   * 是断网、Key 过期还是余额不足 —— 而这三件事的下一步动作完全不同。
   * `hint` 里是可以直接执行的动作，不含服务商原始响应。
   */
  translationError?: { code: string; title: string; hint: string };
  /** Optional natural-English correction when the user speaks unnaturally. */
  correction?: string;
  correctionNote?: string;
  /**
   * 这句外语的中文**近似音**（谐音），例如 "How are you doing?" → 「好 阿 优 度英」。
   *
   * 为什么要存下来而不是每次渲染现算：
   *  1. 历史记录必须能原样还原「当时看到的那行字」，不能因为本地引擎改了就变样；
   *  2. 恢复历史时不允许再调用任何模型（也就不能再花钱、不能再等）；
   *  3. 谐音是近似标注，不是译文，也不等同于准确发音 —— 界面上要写清楚。
   */
  romanization?: string;
  /** 这行提示是用哪种字系算的（hanzi / katakana / romaji），历史要能说清。 */
  hintSystem?: string;
  /** 算这行提示时的算法版本；算法改了，旧值不该再冒充新算法。 */
  hintVersion?: number;
  /**
   * 从历史记录载入时带上的会话内顺序号。
   *
   * 只用于「向上翻更早」的游标（`seq < 当前最早一条`）。实时字幕没有这个字段。
   * 不拿时间戳当游标：同一毫秒里可能有多条，会重复或漏条。
   */
  seq?: number;
  /** 用户明确清空的字段（见 `HISTORY_CLEARABLE_FIELDS`）。 */
  clearedFields?: HistoryField[];
  /**
   * 这一句是从哪个通道进来的：system = 系统回环，mic = 麦克风。
   *
   * 在**字幕产生时**就绑定，不等到写库时按当前设置反推 —— 用户中途把
   * 「线上会议」切成「现场沟通」，前面那些句子不该被一起改写来源。
   */
  audioSource?: 'system' | 'mic';
  /** 这句进来时的理解语言（译文用的语言）。跟着句子走，不按之后改的设置反推。 */
  comprehension?: string;
}

/**
 * 一条可以真的说出口的回复。
 *
 * 字段命名分两代：
 *  · `meaning` / `readingHint` 是 0.6.0 的通用字段 —— 释义可以是中文、日文、
 *    英文，读音提示可以是汉字近音、片假名或罗马字；
 *  · `chinese` / `chinesePronunciation` 是 0.5.0 的旧字段，保留是为了
 *    **历史记录和旧调用点还能读**，新代码一律优先读通用字段。
 */
export interface ReplySuggestion {
  id: string;
  /** simple | natural | continue */
  kind: 'simple' | 'natural' | 'continue';
  /** Text in the target language (English / Russian / Japanese / Korean). */
  english: string;
  /** 旧字段：中文释义。等于 `meaning`（理解语言是中文时）。 */
  chinese: string;
  /** 用**使用者理解的语言**写的释义。 */
  meaning?: string;
  ipa?: string;
  syllables?: string[];
  /** 旧字段：汉字近音。等于 `readingHint`（提示体系是汉字时）。 */
  chinesePronunciation?: string;
  /** 读音提示，字系由 `hintSystem` 决定。 */
  readingHint?: string;
  hintSystem?: HintSystem;
  /**
   * ok = 全部来自词典；approx = 有规则拼出来的近似读音（未核对）；
   * partial = 有片段读音未确定；none = 这个方向没有提示。
   */
  hintStatus?: 'ok' | 'approx' | 'partial' | 'none';
  /** 生成这行提示时用的算法版本，算法改了要重算。 */
  hintVersion?: number;
  /** Latin romanization for Russian (Cyrillic) / Japanese / Korean. */
  romanization?: string;
}

export interface UserProfile {
  name: string;
  city: string;
  interests: string;
}

export interface PronunciationSettings {
  ipa: boolean;
  syllables: boolean;
  /** 旧字段：是否显示中文谐音。等价于 `readingHint`，迁移时同步。 */
  chinesePronunciation: boolean;
  /**
   * 是否显示读音提示（汉字近音 / 片假名 / 罗马字）。
   *
   * 关掉只是不显示，**不会删除**已经算好、已经存进历史的内容 ——
   * 重新打开还在。
   */
  readingHint?: boolean;
  /**
   * 个人词表：用户自己填过的读音（人名、公司名、专业词）。
   *
   * 规则引擎对这些词只能标「未确定」，让用户填一次比让引擎猜一辈子有用。
   * 界面必须标成「你填的」，不能算成专家核对。
   */
  customReadings?: CustomReading[];
}

export interface SubtitleSettings {
  /**
   * 旧字段（0.3.x 只有一个字号，默认 15）。
   *
   * 0.4.0 起原文与译文分开调，这个字段只为「老设置能迁移过来」保留：
   * 迁移时它只决定**原文**字号。
   */
  fontSize: number;
  /** 外语原文字号（12–64，默认 18）。 */
  originalFontSize: number;
  /** 中文译文字号（12–64，默认 24）。译文是主阅读对象。 */
  translationFontSize: number;
  /** 中文近似音（谐音）字号（12–64，默认 18）。和另外两类完全独立。 */
  romanizationFontSize: number;
  /** 阅读模式：双语 / 先看译文 / 只看原文。 */
  readingMode: ReadingMode;
  /** 高对比：纯黑底 + 纯白字。 */
  highContrast: boolean;
  maxItems: number;
  showTranslation: boolean;
  showConfidenceWarning: boolean;
}

export interface AIProviderConfig {
  /**
   * 文本模型（LLM）的国内服务商 id，见 shared/providers.ts。
   * 例如 siliconflow / zhipu / moonshot / deepseek / dashscope / custom。
   */
  provider: string;
  baseURL: string;
  model: string;
  /** 语音识别（STT）服务商 id；可以和 LLM 不是同一家。 */
  sttProvider: string;
  /** STT model, e.g. FunAudioLLM/SenseVoiceSmall */
  sttModel: string;
  sttBaseURL: string;
  /** tts: web-speech | openai */
  ttsProvider: 'web-speech' | 'openai';
  ttsVoice: string;
  ttsSpeed: number;
}

export interface AudioSettings {
  systemDeviceId: string;
  micDeviceId: string;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
  /**
   * 音源用途：决定麦克风收到的是「对方」还是「你自己」。
   *
   * 这是 0.4.0 新增的。旧版本把所有麦克风输入固定当 `user`，于是现场沟通
   * 场景下对方说的话不会被翻译 —— 光把界面名字改成「面对面」是不会变的。
   */
  sourceMode: SourceMode;
  vadSilenceMs: number;
  /**
   * Software gain applied before the VAD. Quiet movie dialogue on laptop
   * speakers often sits under the noise floor otherwise.
   */
  sensitivity: number;
  /** Python interpreter used by the WASAPI sidecar (auto-resolved when empty). */
  pythonPath: string;
}

export interface Settings {
  /**
   * 界面语言。本版只有简体中文。
   *
   * 它和 `nativeLanguage` 是两件事：界面是中文，不代表使用者只能读中文释义。
   */
  uiLanguage?: 'zh-CN';
  /**
   * 使用者**理解的语言** —— 译文与释义翻成这种语言。
   *
   * 0.5.0 之前它叫「母语」，只用来做字幕翻译；生成回复时被忽略，
   * 于是选日语的人拿到的仍是中文释义。现在它同时决定释义语言。
   */
  nativeLanguage: string;
  /**
   * 读音提示体系（汉字近音 / 片假名 / 罗马字 / 不显示）。
   *
   * 刻意与 `nativeLanguage` 分开：读得懂英语的人去日本旅行时，
   * 要的是英文释义 + 罗马字，而不是汉字近音。
   */
  hintSystem?: HintSystem;
  /** 目标语言的地区/口音，只影响朗读选音。 */
  accent?: string;
  /**
   * 字号迁移标记。
   *
   * 0.5.0 的 `readingPrefs()` 每次读到 15/23 都会改成 18/24，于是用户
   * **主动**把字号调成 15 或 23 之后，下次启动又被悄悄改回去。
   * 现在迁移只在 `readingVersion` 缺失时执行一次，执行完打上标记。
   */
  readingVersion?: number;
  /** Language the user wants to SPEAK (English / Russian / Japanese / Korean). */
  targetLanguage: TargetLanguage;
  /** What is being listened to: live chat, a video, or exam listening. */
  scenarioMode: ScenarioMode;
  /** Generate a reply automatically when the other side pauses. */
  autoReplyOnPause: boolean;
  /** How much silence counts as "the video was paused". */
  pauseDetectMs: number;
  /**
   * 语言水平：每种对话语言各记一份（英语 B 级～专八 / 俄语 / 日语 N5～N1 / 韩语 TOPIK）。
   * 切换「对话语言」时互不覆盖。定义见 shared/levels.ts。
   */
  languageLevels: Record<TargetLanguage, string>;
  /**
   * 旧字段：等价于 `languageLevels.English`。
   *
   * 保留它只为了两件事：老设置文件里的值能迁移过来，以及日志 / 自检里仍然能读到
   * 一个明确的英语等级。界面上不再直接改它，写它也会被折进 languageLevels。
   */
  englishLevel: EnglishGrade;
  responseLength: ResponseLength;
  replyStyle: ReplyStyle;
  assistanceLevel: AssistanceLevel;
  uiMode: UiMode;
  pronunciation: PronunciationSettings;
  subtitle: SubtitleSettings;
  ai: AIProviderConfig;
  audio: AudioSettings;
  profile: UserProfile;
  /** Simulate subtitles / translation / replies without any API key. */
  mockMode: boolean;
  /** Whether the built-in sample conversation plays by itself (demo only). */
  demoAutoPlay: boolean;
  /** Speaking correction for the user's own microphone input. */
  speakingCorrection: boolean;
  /**
   * 「关键事实确认卡」。
   *
   * `enabled` 关掉就完全不提取（也不发任何请求）；`useModel` 关掉只留本地
   * 正则（时间/金额/数量），不额外花任何模型额度。
   */
  facts: {
    enabled: boolean;
    useModel: boolean;
  };
  /** Emotional tone used when generating replies (auto = follow the context). */
  tone: ToneKey;
  /** Window behaviour persisted across launches. */
  window: {
    opacity: number;
    alwaysOnTop: boolean;
    locked: boolean;
    bounds: { x: number; y: number; width: number; height: number } | null;
  };
  /** Set once the privacy notice has been acknowledged. */
  privacyAccepted: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  uiLanguage: 'zh-CN',
  nativeLanguage: 'Chinese',
  hintSystem: 'hanzi',
  accent: 'en-US',
  /*
   * 刻意**不**在这里给 `readingVersion` 默认值。
   *
   * 它是「字号迁移做过没有」的闸门。如果这里写 2，那么一份 0.4.0 的旧
   * settings.json（里面是原文 15 / 译文 23、没有这个字段）读进来就会被
   * `deepMerge` 补成 2 —— 迁移以为自己做过了，老用户永远停在 15/23。
   * 留空 = 0，第一次启动才真正迁移一次，之后写回 2 就不会再动。
   */
  targetLanguage: 'English',
  scenarioMode: 'conversation',
  autoReplyOnPause: true,
  pauseDetectMs: 2500,
  languageLevels: {
    English: 'cet4',
    Russian: 'ru-crt4',
    Japanese: 'ja-n3',
    Korean: 'ko-t3',
  },
  englishLevel: 'cet4',
  responseLength: 'normal',
  replyStyle: 'natural',
  assistanceLevel: 'high',
  uiMode: 'advanced',
  pronunciation: {
    ipa: true,
    syllables: true,
    chinesePronunciation: true,
    readingHint: true,
    customReadings: [],
  },
  subtitle: {
    fontSize: 15,
    originalFontSize: 18,
    /**
     * 译文默认 24px。
     *
     * 旧版是 15 - 2 = 13px 且只有 45% 不透明度 —— 对这个软件的目标用户
     * （靠中文译文获取信息）来说，等于把最重要的那一行做成了最看不清的一行。
     */
    translationFontSize: 24,
    /** 中文近似音默认 18px，和原文同档；三类各自独立调整。 */
    romanizationFontSize: 18,
    readingMode: 'both',
    highContrast: false,
    /** How many utterances are kept for scrolling back through the call. */
    maxItems: 200,
    showTranslation: true,
    showConfidenceWarning: true,
  },
  ai: {
    // 只允许国内接口（合规 + 国内直连更稳定）。默认选一家「一个 Key 同时
    // 提供文字模型和语音识别、且有小模型免费」的服务商，开箱即可出字幕。
    provider: 'siliconflow',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    sttProvider: 'siliconflow',
    sttModel: 'FunAudioLLM/SenseVoiceSmall',
    sttBaseURL: 'https://api.siliconflow.cn/v1',
    ttsProvider: 'web-speech',
    ttsVoice: '',
    ttsSpeed: 1.0,
  },
  audio: {
    systemDeviceId: 'default',
    micDeviceId: 'default',
    captureSystemAudio: true,
    captureMicrophone: false,
    // 默认「线上交流」：第一次打开通常是开会 / 看视频，对方的声音从电脑里出来。
    sourceMode: 'online',
    /**
     * 一段话停顿多久算「说完了」。
     *
     * 900ms 会把一句话里的自然换气切成两半，两半各翻一次、读起来就"对不上"；
     * 视频对白尤其明显。提到 1100ms 后切句明显更完整。
     */
    vadSilenceMs: 1100,
    sensitivity: 1.4,
    pythonPath: '',
  },
  profile: {
    name: '',
    city: '',
    interests: '',
  },
  // Real capture is the default: demo mode plays canned lines and cannot hear
  // anything from the computer, which made the app look broken on first run.
  mockMode: false,
  demoAutoPlay: false,
  speakingCorrection: false,
  // 事实卡默认开着（这是产品最有价值的那块），但只对「像是有约定」的句子
  // 才去问模型，避免每句话都多一次请求。
  facts: {
    enabled: true,
    useModel: true,
  },
  tone: 'auto',
  window: {
    opacity: 0.94,
    alwaysOnTop: true,
    locked: false,
    bounds: null,
  },
  privacyAccepted: false,
};

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  level: LogLevel;
  scope: string;
  message: string;
  timestamp: number;
}

/**
 * 采集链路的真实状态。
 *
 * `starting` 是 0.4.0 新增的：点了开始、进程已经拉起来，但音频设备还没确认
 * （sidecar 还没发出 `started`）。没有这一档时，界面要么提前说「正在采集」
 * （其实一个字幕都出不来），要么停在「待机」（用户以为点了没反应）。
 */
export type ListeningStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'paused'
  | 'no-audio'
  | 'offline'
  | 'error';
