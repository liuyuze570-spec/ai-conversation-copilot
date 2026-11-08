import { getSettingsStore, type KeyTarget } from './settings-store';
import { describeError, logger } from './logger';
import { OpenAICompatibleLLM } from '../services/llm/openai-compatible';
import { MockLLM } from '../services/mock/mock-llm';
import { MockTranslator } from '../services/mock/mock-translation';
import { MockSTT } from '../services/mock/mock-stt';
import { OpenAICompatibleSTT } from '../services/stt/openai-stt';
import { LLMTranslator } from '../services/translation/llm-translator';
import { synthesizeOpenAI } from '../services/tts/openai-tts';
import { describeAiError } from '../shared/ai-errors';
import { checkDomesticURL, normalizeBaseURL } from '../shared/providers';
import { sttLanguageCode } from '../shared/types';
import type { AiTestResult, SttLatencyProbe } from '../shared/ipc';
// 「测一次」的音频长度由共享层统一定义：面板、结论、这里必须用同一个数，
// 否则实时率会被算错（一个写 3 秒、另一个写 2 秒，差 1.5 倍）。
import { PROBE_AUDIO_MS } from '../shared/latency';
import type { LLMProvider, SpeechToTextProvider, TranslationProvider } from '../services/types';

function key(target: KeyTarget = 'llm'): string {
  return getSettingsStore().getApiKey(target);
}

/** 每次自动重试都记一笔，方便排查「到底是不是网络在抖」。 */
function onRetry(label: string) {
  return (info: { attempt: number; status?: number; reason: string }) => {
    logger.warn(
      'AI',
      `${label} 第 ${info.attempt} 次重试（${info.reason}${info.status ? ` ${info.status}` : ''}）`,
    );
  };
}

/**
 * Whether the recogniser can actually run.
 *
 * The audio pipeline keeps capturing without a key (so the level meter can
 * still prove the sound is arriving) but must not call the STT endpoint.
 */
export function hasApiKey(target: KeyTarget = 'llm'): boolean {
  const settings = getSettingsStore().get();
  if (settings.mockMode) return true;
  return getSettingsStore().hasApiKey(target);
}

/** 字幕能不能工作：要么有独立的 STT Key，要么 STT 与 LLM 同源可共用。 */
export function hasSttKey(): boolean {
  const settings = getSettingsStore().get();
  if (settings.mockMode) return true;
  return getSettingsStore().keyInfo().sttReady;
}

export function keyInfo() {
  const store = getSettingsStore();
  const settings = store.get();
  if (settings.mockMode) {
    return {
      llm: true,
      stt: true,
      sttShared: true,
      sttReady: true,
      encrypted: true,
      ephemeral: false,
      mismatch: false,
      unknown: false,
    };
  }
  return store.keyInfo();
}

/** The LLM also powers translation, so we only need one model endpoint. */
export function getLLM(): LLMProvider {
  const settings = getSettingsStore().get();
  if (settings.mockMode) return new MockLLM();
  return new OpenAICompatibleLLM({
    apiKey: key('llm'),
    baseURL: settings.ai.baseURL,
    model: settings.ai.model,
    onRetry: onRetry('LLM'),
  });
}

export function getTranslator(): TranslationProvider {
  const settings = getSettingsStore().get();
  if (settings.mockMode) return new MockTranslator();
  return new LLMTranslator(
    new OpenAICompatibleLLM({
      apiKey: key('llm'),
      baseURL: settings.ai.baseURL,
      model: settings.ai.model,
      onRetry: onRetry('Translate'),
    }),
  );
}

export function getSTT(options: { signal?: AbortSignal } = {}): SpeechToTextProvider {
  const settings = getSettingsStore().get();
  if (settings.mockMode) return new MockSTT();
  return new OpenAICompatibleSTT({
    // 这里用的是「经过绑定校验」的 Key：换了服务商但没换 Key 时会是空串，
    // 上层会报「还没填 Key」，而不是把旧 Key 发给新服务商再收一个 401。
    apiKey: getSettingsStore().resolveSttKey(),
    baseURL: settings.ai.sttBaseURL || settings.ai.baseURL,
    model: settings.ai.sttModel || 'FunAudioLLM/SenseVoiceSmall',
    signal: options.signal,
    onRetry: onRetry('STT'),
  });
}

/**
 * 「测试连接」：真的发一次最短的请求。
 *
 * 只告诉用户「失败」没有用，所以这里会明确说出卡在哪一步，并把服务商
 * 返回的原文一起带回去，同时顺手把可用模型列表拉下来（能拉到就直接
 * 填进下拉框，新手不用手打模型名）。
 */
export async function testAIConnection(): Promise<AiTestResult> {
  const settings = getSettingsStore().get();
  const ai = settings.ai;
  const baseURL = normalizeBaseURL(ai.baseURL);
  const endpoint = `${baseURL}/chat/completions`;

  const urlCheck = checkDomesticURL(ai.baseURL);
  if (!urlCheck.ok) {
    return {
      ok: false,
      stage: 'url',
      title: '这个接口地址不能用',
      hint: urlCheck.reason ?? '请从列表里选一家国内服务商。',
      endpoint,
    };
  }

  if (!ai.model) {
    return {
      ok: false,
      stage: 'chat',
      title: '还没有选模型',
      hint: '在下面的「模型」下拉框里选一个（带「免费」字样的最省心）。',
      endpoint,
    };
  }

  const apiKey = getSettingsStore().getApiKey('llm');
  if (!apiKey) {
    return {
      ok: false,
      stage: 'key',
      title: '还没有填 API Key',
      hint: '点上面的「去申请 Key」，按新手教程拿到 Key 后粘贴到输入框并保存。',
      endpoint,
    };
  }

  try {
    const llm = new OpenAICompatibleLLM({
      apiKey,
      baseURL,
      model: ai.model,
      timeoutMs: 20_000,
      retries: 1,
      onRetry: onRetry('Test'),
    });
    const { latencyMs, reply } = await llm.ping();

    let models: string[] = [];
    try {
      models = await llm.listModels();
    } catch {
      // 很多网关不提供 /models，拉不到不算失败。
    }

    logger.info('AI', `connection test ok (${ai.model}, ${latencyMs}ms)`);
    return {
      ok: true,
      stage: 'done',
      title: `连接成功 · 用了 ${latencyMs} 毫秒`,
      hint: `模型「${ai.model}」回了一句：${reply || '(空)'}`,
      latencyMs,
      model: ai.model,
      reply,
      endpoint,
      models: models.slice(0, 400),
    };
  } catch (error) {
    const info = describeAiError(error);
    logger.error('AI', `connection test failed: ${info.code}`);
    return {
      ok: false,
      stage: 'chat',
      title: info.title,
      hint: info.hint,
      raw: info.raw,
      endpoint,
    };
  }
}

/** 只拉模型列表（设置页点「刷新模型」时用）。 */
export async function fetchModelList(): Promise<{
  ok: boolean;
  models: string[];
  message?: string;
}> {
  const settings = getSettingsStore().get();
  const ai = settings.ai;
  const urlCheck = checkDomesticURL(ai.baseURL);
  if (!urlCheck.ok) return { ok: false, models: [], message: urlCheck.reason };
  const apiKey = getSettingsStore().getApiKey('llm');
  if (!apiKey) return { ok: false, models: [], message: '还没有填 API Key' };

  try {
    const llm = new OpenAICompatibleLLM({
      apiKey,
      baseURL: ai.baseURL,
      model: ai.model,
      timeoutMs: 15_000,
      retries: 1,
    });
    const models = await llm.listModels();
    return { ok: true, models };
  } catch (error) {
    const info = describeAiError(error);
    return { ok: false, models: [], message: info.title };
  }
}

/**
 * 合成语音，返回 base64 mp3（失败返回空串）。
 *
 * `speedOverride` 是「慢速播放（0.7x）」用的：旧实现完全忽略它，所以云端
 * 朗读模式下那个 0.7x 按钮**点了没反应** —— 只有系统朗读模式（走浏览器的
 * SpeechSynthesisUtterance.rate）才真的变慢。现在两条路都传得下去。
 */
export async function synthesizeSpeech(
  text: string,
  speedOverride?: number,
  signal?: AbortSignal,
): Promise<string> {
  const settings = getSettingsStore().get();
  if (!text.trim()) return '';
  if (settings.ai.ttsProvider !== 'openai') return '';
  const speed = clampSpeed(speedOverride ?? settings.ai.ttsSpeed ?? 1);
  try {
    const buffer = await synthesizeOpenAI(text, {
      apiKey: key('llm'),
      baseURL: settings.ai.baseURL,
      model: 'gpt-4o-mini-tts',
      voice: settings.ai.ttsVoice || 'alloy',
      speed,
      signal,
    });
    return Buffer.from(buffer).toString('base64');
  } catch (error) {
    // 用户点停止 / 换了一句要念：这不是故障，返回空串让界面安静收场。
    if (signal?.aborted) {
      logger.info('TTS', 'synthesis cancelled by user');
      return '';
    }
    logger.error('TTS', `synthesize failed: ${describeError(error)}`);
    return '';
  }
}

/** 各家 TTS 对 speed 的接受范围差得不远，统一夹在 0.5–2，避免直接被 400。 */
function clampSpeed(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0.5, value));
}

export async function translateText(
  text: string,
  context: string[] = [],
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const settings = getSettingsStore().get();
  const translator = getTranslator();
  try {
    return await translator.translate({
      text,
      from: settings.targetLanguage,
      to: settings.nativeLanguage,
      context,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logger.error('Translate', `failed: ${describeError(error)}`);
    throw error;
  }
}

/**
 * 自己合成一段音频，打给真实的识别接口，量一次往返。
 *
 * 为什么需要它：实时字幕的体验上限就是这段耗时 —— 识别一段 3 秒的话如果要花 5 秒，
 * 后面所有交互优化都是白费。但这个数字本来只有「装了 Key + 有音频在放」时才拿得到，
 * 而这两件事用户未必同时具备（也正因为如此，开发机上的真实链路长期没被量过）。
 * 这里绕开声卡：音频自己造，只量时间和真实模型的往返。
 *
 * 诚实说明：量到的是**纯模型 + 网络**的耗时，不含音频采集与切句，所以真实使用时
 * 会比这个数字更长一点。合成音也不保证被识别成有效文字 —— 我们只关心它花了多久。
 */
export async function probeSttLatency(seconds = PROBE_AUDIO_MS / 1000): Promise<SttLatencyProbe> {
  const settings = getSettingsStore().get();
  const model = settings.ai.sttModel || 'FunAudioLLM/SenseVoiceSmall';
  const audioMs = Math.round(seconds * 1000);

  if (!hasSttKey()) {
    return {
      ok: false,
      ms: 0,
      audioMs,
      model,
      chars: 0,
      message: '还没有可用的语音识别 Key，先去「API 功能」里配一个。',
    };
  }

  const audio = synthSpeechLikeWav(seconds);
  const started = Date.now();
  try {
    const result = await Promise.race([
      getSTT().transcribe({
        audio,
        mimeType: 'audio/wav',
        language: sttLanguageCode(settings.targetLanguage),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('STT_PROBE_TIMEOUT')), 45_000),
      ),
    ]);
    const ms = Date.now() - started;
    logger.info('AI', `stt latency probe: ${ms}ms for ${audioMs}ms audio (${model})`);
    return { ok: true, ms, audioMs, model, chars: result.text.trim().length };
  } catch (error) {
    const info = describeAiError(error);
    logger.error('AI', `stt latency probe failed: ${info.code}`);
    return {
      ok: false,
      ms: Date.now() - started,
      audioMs,
      model,
      chars: 0,
      message: `${info.title}｜${info.hint}`,
    };
  }
}

/**
 * 造一段「像说话」的 16 kHz 单声道 WAV。
 *
 * 刻意不用纯正弦：纯音很容易被识别模型当成静音直接短路，那样量出来的时间不代表
 * 真实语音的解码成本。这里用两个谐波叠一个缓慢起伏的包络，听起来像拖长的元音。
 */
function synthSpeechLikeWav(seconds: number, rate = 16000): Uint8Array {
  const frames = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // 单声道
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);

  for (let index = 0; index < frames; index += 1) {
    const t = index / rate;
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.1 * t);
    const wave =
      Math.sin(2 * Math.PI * 175 * t) + 0.55 * Math.sin(2 * Math.PI * 350 * t);
    const sample = Math.max(-1, Math.min(1, wave * 0.32 * envelope));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return new Uint8Array(buffer);
}
