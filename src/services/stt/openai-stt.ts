import type { SpeechToTextProvider, TranscribeRequest, TranscriptionResult } from '../types';
import { errorDetailFromText, requestJson, type RequestOptions } from '../llm/http';
import { checkDomesticURL, normalizeBaseURL } from '../../shared/providers';

export interface STTConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** 上传音频 + 识别通常比较慢，默认给 60 秒（总预算，含重试与读 body）。 */
  timeoutMs?: number;
  retries?: number;
  onRetry?: RequestOptions['onRetry'];
  /** 外部取消信号（停止监听时用）。 */
  signal?: AbortSignal;
}

/**
 * OpenAI-compatible speech-to-text (Whisper / SenseVoice).
 * 国内的硅基流动、魔搭、阿里云百炼都提供同一套 /audio/transcriptions 接口。
 */
export class OpenAICompatibleSTT implements SpeechToTextProvider {
  readonly id = 'openai-whisper';
  readonly displayName = 'Whisper (OpenAI compatible)';

  private config: STTConfig;

  constructor(config: STTConfig) {
    this.config = config;
  }

  updateConfig(config: Partial<STTConfig>) {
    this.config = { ...this.config, ...config };
  }

  private get baseURL(): string {
    return normalizeBaseURL(this.config.baseURL);
  }

  private get endpoint(): string {
    return `${this.baseURL}/audio/transcriptions`;
  }

  async transcribe(request: TranscribeRequest): Promise<TranscriptionResult> {
    if (!this.config.apiKey) throw new Error('MISSING_API_KEY');
    if (!this.config.model) throw new Error('MISSING_MODEL');
    if (!request.audio || request.audio.byteLength === 0) {
      throw new Error('EMPTY_AUDIO');
    }

    const urlCheck = checkDomesticURL(this.config.baseURL);
    if (!urlCheck.ok) {
      throw new Error(`FOREIGN_ENDPOINT: ${urlCheck.reason ?? this.config.baseURL}`);
    }

    const form = new FormData();
    const blob = new Blob([request.audio as unknown as BlobPart], {
      type: request.mimeType || 'audio/wav',
    });
    form.append('file', blob, `speech.${extensionFor(request.mimeType)}`);
    form.append('model', this.config.model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (request.language) form.append('language', request.language);
    if (request.prompt) form.append('prompt', request.prompt.slice(0, 800));

    const result = await requestJson<{ text?: unknown; language?: unknown; segments?: unknown }>(
      this.endpoint,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: form,
      },
      {
        timeoutMs: this.config.timeoutMs ?? 60_000,
        retries: this.config.retries ?? 1,
        signal: request.signal ?? this.config.signal,
        onRetry: this.config.onRetry,
      },
    );

    if (!result.ok) {
      const detail = errorDetailFromText(result.text);
      throw new Error(`STT_HTTP_${result.status}: ${detail.slice(0, 200)}`);
    }
    if (!result.data) {
      throw new Error(`STT_BAD_JSON: ${result.text.slice(0, 120)}`);
    }

    // 字段类型一律不信模型/网关：`text` 给个数字或 null 都要能撑住，
    // 不能让 `.trim()` 把整条字幕链炸掉。
    const text = typeof result.data.text === 'string' ? result.data.text.trim() : '';
    const language =
      typeof result.data.language === 'string' ? result.data.language : undefined;

    let confidence: number | undefined;
    const segments = Array.isArray(result.data.segments) ? result.data.segments : [];
    if (segments.length) {
      const avg =
        segments.reduce((sum, segment) => {
          const value =
            segment && typeof segment === 'object'
              ? Number((segment as { avg_logprob?: unknown }).avg_logprob)
              : Number.NaN;
          return sum + Math.exp(Number.isFinite(value) ? value : -0.5);
        }, 0) / segments.length;
      confidence = Math.max(0, Math.min(1, Number(avg.toFixed(2))));
    }

    return { text, confidence, language };
  }
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'wav';
}
