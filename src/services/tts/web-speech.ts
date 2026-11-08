import type { SpeakRequest, TTSProvider } from '../types';

/**
 * Zero-config TTS using the OS voices (Windows has en-US voices offline).
 *
 * 两个细节是踩过的坑：
 * 1. `speechSynthesis.cancel()` 之后，被取消那条 utterance 的 Promise **永远不会
 *    结束**（既不 onend 也不 onerror）。旧实现就这样把调用方挂在 `await` 上，
 *    切歌 / 点停止之后界面的「正在朗读」图标一直不消。现在 stop() 主动收尾。
 * 2. 连续点两次播放时，旧的那条要先取消再排新的，否则 Windows 上会两条叠着念。
 *
 * 0.6.0 补上第三件事：**没有目标语言的语音时不许拿别的语言顶上**。
 * 以前的 `pickVoice()` 在找不到 ja-JP 时会退到 `voices[0]`，于是用户点「朗读」，
 * 听到的是一段用英语腔念出来的日语罗马字，而界面显示一切正常。
 * 现在找不到就明确报 `TTS_LANG_UNAVAILABLE`，让界面告诉用户去装语言包。
 */
export class WebSpeechTTS implements TTSProvider {
  readonly id = 'web-speech';
  readonly displayName = 'System voice (offline)';

  private voices: SpeechSynthesisVoice[] = [];
  /** 当前这条的 resolver / rejecter —— stop() 要能把它们叫醒。 */
  private pending: { resolve: () => void } | null = null;

  private ensureVoices() {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    if (!this.voices.length) this.voices = window.speechSynthesis.getVoices();
  }

  listVoices(): { name: string; lang: string }[] {
    this.ensureVoices();
    return this.voices.map((voice) => ({ name: voice.name, lang: voice.lang }));
  }

  /** 某种语言有哪些可用语音。界面用它显示「当前语音 / 缺少语音」。 */
  voicesFor(lang: string): { name: string; lang: string }[] {
    this.ensureVoices();
    const wanted = lang.toLowerCase().split('-')[0];
    return this.voices
      .filter((voice) => voice.lang.toLowerCase().startsWith(wanted))
      .map((voice) => ({ name: voice.name, lang: voice.lang }));
  }

  /**
   * 选一个**语言对得上**的语音。
   *
   * 返回 `undefined` 表示「这台机器上没有这种语言的语音」——调用方必须
   * 当作失败处理，不能退回英语。
   */
  private pickVoice(preferred: string | undefined, lang: string): SpeechSynthesisVoice | undefined {
    this.ensureVoices();
    if (!this.voices.length) return undefined;
    const wanted = lang.toLowerCase();
    const base = wanted.split('-')[0];
    const matching = this.voices.filter((voice) => voice.lang.toLowerCase().startsWith(base));
    if (!matching.length) return undefined;

    if (preferred) {
      // 指定了语音名也要先核对语言：用户可能换过目标语言，而旧语音名还留着。
      const exact = matching.find((voice) => voice.name === preferred);
      if (exact) return exact;
    }
    return matching.find((voice) => voice.lang.toLowerCase() === wanted) ?? matching[0];
  }

  speak(request: SpeakRequest): Promise<void> {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      return Promise.reject(Object.assign(new Error('TTS_NOT_AVAILABLE'), { code: 'TTS_NOT_AVAILABLE' }));
    }

    const synth = window.speechSynthesis;
    // 先收掉上一句（并把它等着的 Promise 结束掉），再排新的。
    this.stop();

    const lang = request.lang || 'en-US';
    this.ensureVoices();
    const voice = this.pickVoice(request.voice, lang);

    /*
     * 语音列表为空 = 系统还没加载完（Windows 上首帧常常是空的），
     * 这时仍然让系统自己挑 —— 比直接拒绝用户体验好。
     * 列表非空但没有这种语言 = 真的缺语言包，必须报错。
     */
    if (!voice && this.voices.length > 0) {
      return Promise.reject(
        Object.assign(new Error(`TTS_LANG_UNAVAILABLE:${lang}`), {
          code: 'TTS_LANG_UNAVAILABLE',
          lang,
        }),
      );
    }

    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.lang = voice?.lang || lang;
    // 慢速播放就是靠这一行生效的（系统语音模式）。
    utterance.rate = Math.min(2, Math.max(0.5, request.speed ?? 1));
    utterance.pitch = 1;
    if (voice) utterance.voice = voice;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (this.pending?.resolve === resolve) this.pending = null;
        resolve();
      };
      const fail = (code: string) => {
        if (settled) return;
        settled = true;
        if (this.pending?.resolve === resolve) this.pending = null;
        /*
         * onerror 不等于「念完了」。
         *
         * 以前两条路径都调 done()，于是「语音引擎报错」在界面上表现为
         * 「播放成功」，用户点一次没声音、再点还是没有，也不知道为什么。
         */
        reject(Object.assign(new Error(`TTS_FAILED:${code}`), { code: 'TTS_FAILED', detail: code }));
      };
      this.pending = { resolve };
      utterance.onend = done;
      utterance.onerror = (event) => fail(String((event as SpeechSynthesisErrorEvent).error ?? 'unknown'));
      synth.speak(utterance);
    });
  }

  stop() {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    const pending = this.pending;
    this.pending = null;
    // 被取消不是失败：安静收场，调用方不需要弹错。
    pending?.resolve();
  }
}
