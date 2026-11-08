/**
 * Provider abstraction. Every external capability is behind an interface so we
 * can swap OpenAI / Azure / DeepSeek / Groq / local Whisper later without
 * touching the UI.
 */
import type {
  ReplyStyle,
  ResponseLength,
  ScenarioMode,
  TargetLanguage,
  ToneKey,
} from '../shared/types';
import type { HintSystem } from '../shared/languages';

export interface TranscribeRequest {
  /** Raw audio bytes (wav / webm / mp3). */
  audio: Uint8Array;
  mimeType: string;
  language?: string;
  prompt?: string;
  /**
   * 取消信号。
   *
   * 停止监听 / 重启监听时必须能掐掉在途的识别请求：不然旧请求还会跑完、
   * 还会回来写字幕，甚至把新一轮的画面撬走。顺带也省掉白烧的额度。
   */
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  confidence?: number;
  language?: string;
}

export interface SpeechToTextProvider {
  readonly id: string;
  readonly displayName: string;
  transcribe(request: TranscribeRequest): Promise<TranscriptionResult>;
}

export interface TranslateRequest {
  text: string;
  from: string;
  to: string;
  /** Recent conversation lines, improves spoken-style translation. */
  context?: string[];
  /**
   * 取消信号。
   *
   * 停止监听 / 关闭回复面板 / 发起新的替代请求时，在途的翻译必须被真的掐断：
   * 它既能省下白烧的额度，也避免「迟到结果把已经标成 cancelled 的字幕改回 ok」。
   */
  signal?: AbortSignal;
}

export interface TranslationProvider {
  readonly id: string;
  readonly displayName: string;
  translate(request: TranslateRequest): Promise<string>;
}

export interface ReplyRequest {
  /** Recent conversation, formatted as "Foreign: ...\nYou: ...". */
  context: string;
  /**
   * 语言水平：值来自 shared/levels.ts，跟着 `language` 变 ——
   * 英语是 cet4 / tem8 这类，日语是 ja-n3，韩语是 ko-t3。
   */
  level: string;
  style: ReplyStyle;
  length: ResponseLength;
  profile?: { name?: string; city?: string; interests?: string };
  mode: ReplyMode;
  /** Emotional tone; 'auto' means "fit the conversation". */
  tone?: ToneKey;
  /** Language the reply must be spoken in. */
  language?: TargetLanguage;
  /** What is being listened to (live chat / video / exam listening). */
  scenario?: ScenarioMode;
  /** Existing reply to rewrite (for simplify / rephrase / natural). */
  current?: string;
  /**
   * 用户自己打的一句话（想说的意思）。
   *
   * 字段名沿用历史的 `chinese`，但内容不一定是中文 —— 一个日语使用者
   * 会打日语。真正是什么语言由 `comprehension` 决定。
   */
  chinese?: string;
  /**
   * 使用者**理解的语言** —— `meaning` 字段要写成这种语言。
   *
   * 以前这里没有这个字段，于是生成回复时完全不看设置里的母语，
   * 选日语的人拿到的仍是中文释义。
   */
  comprehension?: string;
  /** 读音提示体系（汉字近音 / 片假名 / 罗马字）。 */
  hintSystem?: HintSystem;
}

export type ReplyMode =
  | 'reply'
  | 'simple'
  | 'natural'
  | 'continue'
  | 'rephrase'
  | 'simplify'
  | 'didnt-catch'
  | 'from-chinese';

export interface LLMProvider {
  readonly id: string;
  readonly displayName: string;
  /**
   * `options.signal`：停止监听 / 关闭面板 / 被新请求替代时真的掐断在途生成。
   * 只丢结果不掐请求的话，用户的每一次「改个语气」都在白烧一次十几秒的额度。
   */
  generateReplies(
    request: ReplyRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ReplyDraft[]>;
  /** Free-form completion used for translation and polishing. */
  complete(prompt: string): Promise<string>;
  /**
   * 原始的对话补全（翻译 / 事实提取 / 确认句都走它）。
   *
   * 以前只有 `complete(prompt)`，没有地方能传「要 JSON」和「取消信号」，
   * 于是每条新增的 AI 能力都得自己拼一套请求。现在统一走这一个入口。
   * 模拟实现可以不实现它（`facts-service` 里对 mock 有降级）。
   */
  chat?(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    temperature: number,
    options?: { json?: boolean; plain?: boolean },
    signal?: AbortSignal,
  ): Promise<string>;
}

/** One raw suggestion returned by an LLM before pronunciation enrichment. */
export interface ReplyDraft {
  kind: 'simple' | 'natural' | 'continue';
  english: string;
  /** 旧字段：中文释义。新代码用 `meaning`。 */
  chinese: string;
  /** 用使用者理解的语言写的释义。 */
  meaning?: string;
  ipa?: string;
  syllables?: string[];
  /** 旧字段：汉字近音。新代码用 `readingHint`。 */
  chinesePronunciation?: string;
  /** 读音提示（字系由 hintSystem 决定）。 */
  readingHint?: string;
  /** 这行提示的可信程度（ok / approx / partial / none），由本地引擎算出。 */
  hintStatus?: 'ok' | 'approx' | 'partial' | 'none';
  /** Latin romanization (Russian / Japanese / Korean). */
  romanization?: string;
}

export interface SpeakRequest {
  text: string;
  voice?: string;
  speed?: number;
  /** BCP-47 language tag, e.g. en-US / ru-RU / ja-JP / ko-KR. */
  lang?: string;
}

export interface TTSProvider {
  readonly id: string;
  readonly displayName: string;
  speak(request: SpeakRequest): Promise<void>;
  stop(): void;
}

export interface AudioCaptureProvider {
  readonly id: string;
  readonly displayName: string;
  listDevices(): Promise<{ id: string; name: string; kind: 'system' | 'mic' }[]>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
