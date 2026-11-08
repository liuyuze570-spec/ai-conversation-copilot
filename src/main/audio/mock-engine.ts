import type { BrowserWindow } from 'electron';
import {
  IPC,
  type AudioLevelPayload,
  type AudioStatusPayload,
  type TranscriptPayload,
} from '../../shared/ipc';
import { logger } from '../logger';
import { getSettingsStore } from '../settings-store';
import type { TargetLanguage } from '../../shared/types';
import type { DemoLine } from '../../services/mock/corpus';
import { LANGUAGE_SCENARIOS, SCENARIOS } from '../../services/mock/corpus';
import { directionFor, samplesFor, sampleVariant } from '../../shared/samples';

export interface AudioEngine {
  start(): void | Promise<void>;
  stop(): void;
  /**
   * 等设备确认（只有真实采集引擎需要）。
   *
   * 主控用它决定「启动到底算不算成功」：拿不到确认就不许报 ok。
   * 演示引擎没有设备，不实现这个方法即视为立刻就绪。
   */
  waitUntilReady?(ms: number): Promise<{ ok: boolean; message: string; timedOut?: boolean }>;
  /** 引擎死亡（进程退出 / 设备丢失）时回调 —— 主控据此清掉配置指纹。 */
  onDead?: (reason: string) => void;
  /** 每一帧响度（主控用来判断「最近有没有声音」）。 */
  onLevel?: (level: AudioLevelPayload) => void;
  /** 丢了一段音频（积压 / 识别超时），界面要留一个「这里少了一句」的标记。 */
  onDropped?: (info: { at: number; reason: string }) => void;
}

export type { DemoLine };

/** Backwards-compatible default script (first scenario). */
export const DEMO_SCRIPT: DemoLine[] = SCENARIOS[0].lines;

const WORD_DELAY_MS = 110;
const GAP_MS = 1400;

/**
 * Mock engine: plays a scripted conversation through the exact same
 * transcript pipeline used by the real Windows audio capture, so the whole
 * UI / context / AI flow can be developed and demoed without an API key.
 */
export class MockAudioEngine implements AudioEngine {
  private timer: NodeJS.Timeout | null = null;
  private scenarioIndex = Math.floor(Math.random() * SCENARIOS.length);
  private lineIndex = 0;
  private wordIndex = 0;
  private current: string[] = [];
  private running = false;
  /** 主控注入：每推一次电平就同步给「最近有没有声音」的窗口。 */
  onLevel?: (level: AudioLevelPayload) => void;
  /** 演示开始时刻，只用来算「已采集几秒」。 */
  private startedAt = Date.now();

  constructor(private readonly win: BrowserWindow) {}

  /** Scenarios for the currently selected target language. */
  private scenarios() {
    const settings = getSettingsStore().get();
    const language = settings.targetLanguage as TargetLanguage;
    /*
     * 理解语言不是中文时，演示脚本改成那三句样例。
     *
     * 内置语料只有中文译文（几十套台词逐句补日语/英语等于批量生产没人核对过
     * 的译文）。换成样例之后，演示里每一句都有对应的、写在同一个文件里的
     * 参考译文，字幕、事实卡、读音提示才不会各说各话。
     */
    if (settings.nativeLanguage !== 'Chinese') {
      const direction = directionFor(settings.nativeLanguage, language);
      const list = samplesFor(settings.nativeLanguage, language);
      if (direction && list.length) {
        return list
          .map((sample) => {
            const variant = sampleVariant(sample, direction);
            if (!variant) return null;
            return {
              id: sample.id,
              name: `样例 · ${sample.title}`,
              lines: [
                {
                  speaker: 'foreign' as const,
                  english: variant.original,
                  chinese: variant.translation,
                  confidence: 0.95,
                },
              ],
            };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);
      }
    }
    return LANGUAGE_SCENARIOS[language] ?? SCENARIOS;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    // Be explicit: this mode cannot hear the computer, and users rightly
    // expect subtitles from whatever they are playing.
    this.emitStatus({
      status: 'listening',
      message: '演示模式：只播放内置示例，听不到电脑里的声音（设置里可关闭）',
    });

    const settings = getSettingsStore().get();
    if (!settings.demoAutoPlay) {
      // Sample conversation is opt-in — stay silent until the user turns it on.
      logger.info('Audio', 'mock engine listening (demo auto-play is off)');
      return;
    }

    const list = this.scenarios();
    const scenario = list[this.scenarioIndex % list.length];
    logger.info('Audio', `mock engine started (scenario: ${scenario.name})`);
    this.tick();
  }

  /** Push exactly one demo line, even when auto-play is switched off. */
  sayOnce() {
    const list = this.scenarios();
    const scenario = list[this.scenarioIndex % list.length];
    const line = scenario.lines[this.lineIndex % scenario.lines.length];
    this.lineIndex = (this.lineIndex + 1) % scenario.lines.length;
    // 只记场景名和字数：app.log 里不留对话正文（和真实识别路径保持同一口径）。
    logger.info('Audio', `mock one-shot line (${scenario.name}) chars=${line.english.length}`);
    // 「说一句示例」也是一句真的进来的话，状态条同样要变成「正在采集」。
    if (line.speaker === 'foreign') this.pulseLevel();
    this.emit({
      speaker: line.speaker,
      text: line.english,
      partial: false,
      confidence: line.confidence,
    });
    return line.english;
  }

  /**
   * 推一句**指定文本**（只给自检用）。
   *
   * 演示语料里几乎没有时间/金额，所以「关键事实确认卡」在演示模式下永远
   * 不会触发 —— 想真实验证那条链路（定稿 → 规则提取 → store → 面板），
   * 就必须能塞一句带事实的话进去。调用方已用 `COPILOT_SELFTEST` 收口。
   */
  sayText(text: string) {
    logger.info('Audio', `mock selftest line chars=${text.length}`);
    this.pulseLevel();
    this.emit({ speaker: 'foreign', text, partial: false, confidence: 0.95 });
    return text;
  }

  /**
   * 演示模式下也要有「电平」。
   *
   * 不推电平的话，顶部状态条会一直显示「采集中，暂未收到声音」—— 而屏幕上
   * 字幕明明在往下滚，两句话互相打脸。演示引擎当然没有真实声卡，但它**确实
   * 收到了一句「声音」**（语料），所以按这一句话的时长推几次电平是诚实的，
   * 不是编数据：不说「听到了麦克风的声音」，只说「刚刚有内容进来」。
   *
   * 只推 `source: 'system'`（演示脚本扮演的都是电脑里播出来的对方声音），
   * 并且 1.4 秒后推一次静音，让状态条自然回到「等下一句」。
   */
  private pulseLevel() {
    const captured = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    const levels = [0, 320, 700];
    for (const delay of levels) {
      setTimeout(() => {
        if (!this.running) return;
        const level: AudioLevelPayload = {
          rms: 0.18,
          peak: 0.42,
          db: -18,
          speaking: true,
          capturedSeconds: captured,
          source: 'system',
          device: '演示语料',
        };
        this.send(IPC.AUDIO_LEVEL, level);
        this.onLevel?.(level);
      }, delay);
    }
    // 一句话说完 → 电平落回底噪，状态条回到「采集中」等待下一句。
    setTimeout(() => {
      if (!this.running) return;
      const idle: AudioLevelPayload = {
        rms: 0,
        peak: 0,
        db: -120,
        speaking: false,
        capturedSeconds: captured,
        source: 'system',
        device: '演示语料',
      };
      this.send(IPC.AUDIO_LEVEL, idle);
      this.onLevel?.(idle);
    }, 1400);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Audio', 'mock engine stopped');
    this.emitStatus({ status: 'paused' });
  }

  private send(channel: string, payload: unknown) {
    try {
      const win = this.win;
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        this.running = false;
        return;
      }
      win.webContents.send(channel, payload);
    } catch {
      this.running = false;
    }
  }

  private emitStatus(payload: AudioStatusPayload) {
    this.send(IPC.AUDIO_STATUS, payload);
  }

  private emit(payload: TranscriptPayload) {
    this.send(IPC.AUDIO_TRANSCRIPT, payload);
  }

  private schedule(ms: number) {
    this.timer = setTimeout(() => {
      if (!this.running) return;
      this.tick();
    }, ms);
  }

  private tick() {
    const list = this.scenarios();
    const scenario = list[this.scenarioIndex % list.length];
    const line = scenario.lines[this.lineIndex];
    const words = line.english.split(' ');

    if (this.wordIndex === 0) this.current = [];

    if (this.wordIndex < words.length) {
      this.current.push(words[this.wordIndex]);
      this.wordIndex += 1;
      this.emit({
        speaker: line.speaker,
        text: this.current.join(' '),
        partial: true,
        confidence: line.confidence * 0.8,
      });
      this.schedule(WORD_DELAY_MS);
      return;
    }

    /*
     * 一句话说完了：先推几次电平，再交终稿。
     *
     * 演示模式没有真实声卡，但「刚刚确实有一句话进来了」是事实 —— 状态条要
     * 因此从「暂未收到声音」变成「正在采集」，否则屏幕上字幕在滚、状态条却
     * 说没收到声音，两句话互相打脸。
     */
    if (line.speaker === 'foreign') this.pulseLevel();

    // Finalize the sentence, then move to the next line after a short pause.
    this.emit({
      speaker: line.speaker,
      text: line.english,
      partial: false,
      confidence: line.confidence,
    });
    this.wordIndex = 0;
    this.current = [];
    this.lineIndex += 1;

    // Scenario finished → move to a different one so the demo never gets stale.
    if (this.lineIndex >= scenario.lines.length) {
      this.lineIndex = 0;
      this.scenarioIndex =
        (this.scenarioIndex + 1 + Math.floor(Math.random() * Math.max(1, list.length - 1))) %
        list.length;
      const next = list[this.scenarioIndex];
      logger.info('Audio', `mock scenario → ${next.name}`);
    }
    this.schedule(GAP_MS);
  }
}
