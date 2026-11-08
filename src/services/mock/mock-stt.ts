import type { SpeechToTextProvider, TranscribeRequest, TranscriptionResult } from '../types';

/**
 * Mock STT. Real audio never reaches here — Mock mode streams the scripted
 * dialogue straight into the transcript pipeline.
 */
export class MockSTT implements SpeechToTextProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock STT (offline)';

  async transcribe(_request: TranscribeRequest): Promise<TranscriptionResult> {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { text: '', confidence: 0 };
  }
}
