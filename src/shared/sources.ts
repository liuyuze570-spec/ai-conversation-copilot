import type { Speaker } from './types';

/**
 * 音源用途。
 *
 * 这个字段是 0.4.0 新增的，解决一个真实的误判：旧代码把所有**麦克风**输入
 * 一律标成 `user`（= 使用者自己在说话），也一律不翻译。这在「线上会议」里
 * 是对的，但在「面对面沟通」里恰好反过来 —— 麦克风收到的是**对方**的声音，
 * 那才是需要翻译的那一路。只把界面名字从「对话」改成「面对面」而不动这条
 * 路由，等于宣称支持了一个根本没实现的功能。
 *
 * - `online` 线上交流：电脑里播放的声音是对方（系统声音 → 对方 → 翻译）。
 * - `onsite` 现场沟通：麦克风收到的是对方（麦克风 → 对方 → 翻译）。
 */
export type SourceMode = 'online' | 'onsite';

export interface SourcePlanItem {
  /** 底层采集通道。 */
  channel: 'loopback' | 'mic';
  /** 这条通道收到的声音是谁在说。 */
  speaker: Speaker;
  /** 界面上要显示的名字。 */
  label: string;
  /** 这条通道的作用，一句话说清为什么要开它。 */
  purpose: string;
  /** 是否进入「显示译文」的链路。 */
  translate: boolean;
}

export interface SourcePlan {
  mode: SourceMode;
  items: SourcePlanItem[];
  /** 需要提醒用户的冲突 / 缺失（不阻断启动）。 */
  warning?: string;
  /** 音频主通道（决定状态条上写「电脑声音」还是「麦克风」）。 */
  primary: 'loopback' | 'mic' | 'none';
}

export interface SourceInput {
  sourceMode: SourceMode;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
}

export const SOURCE_MODE_OPTIONS: { value: SourceMode; label: string; hint: string }[] = [
  {
    value: 'online',
    label: '线上交流（电脑里的声音）',
    hint: '对方在会议 / 视频 / 语音里说话，声音从电脑扬声器出来',
  },
  {
    value: 'onsite',
    label: '现场沟通（麦克风听对方）',
    hint: '对方就在旁边说话，用麦克风把他的话收进来',
  },
];

export function sourceModeLabel(mode: SourceMode): string {
  return SOURCE_MODE_OPTIONS.find((item) => item.value === mode)?.label ?? '线上交流（电脑里的声音）';
}

/** 这条通道是不是「对方」——决定要不要翻译。 */
export function speakerOf(channel: 'loopback' | 'mic', mode: SourceMode): Speaker {
  if (channel === 'loopback') return 'foreign';
  return mode === 'onsite' ? 'foreign' : 'user';
}

/**
 * 把设置解析成「这次到底采什么、谁在说、翻不翻」。
 *
 * 现场模式同时开系统声音是明确要拦的：对方的手机外放着说话、电脑又在放
 * 同一场会议的远端声音，两路都会出字幕，同一句话出现两遍、还互相打断，
 * 用户根本没法读。规则：现场模式只认麦克风，系统声音让位并给出原因。
 */
export function resolveSources(input: SourceInput): SourcePlan {
  const { sourceMode, captureSystemAudio, captureMicrophone } = input;

  if (sourceMode === 'onsite') {
    if (!captureMicrophone) {
      return {
        mode: sourceMode,
        items: [],
        primary: 'none',
        warning: '现场沟通要用麦克风收对方的声音：请打开「麦克风」或改用「线上交流」。',
      };
    }
    return {
      mode: sourceMode,
      items: [
        {
          channel: 'mic',
          speaker: 'foreign',
          label: '麦克风',
          purpose: '收对方的声音，显示原文 + 中文译文',
          translate: true,
        },
      ],
      primary: 'mic',
      warning: captureSystemAudio
        ? '现场沟通只用麦克风：系统声音已让位，避免同一句话出两遍字幕。'
        : undefined,
    };
  }

  const items: SourcePlanItem[] = [];
  if (captureSystemAudio) {
    items.push({
      channel: 'loopback',
      speaker: 'foreign',
      label: '系统声音',
      purpose: '收电脑里对方的声音，显示原文 + 中文译文',
      translate: true,
    });
  }
  if (captureMicrophone) {
    items.push({
      channel: 'mic',
      speaker: 'user',
      label: '麦克风',
      purpose: '收你自己说话的声音，只做口语提示，不翻译',
      translate: false,
    });
  }
  if (!items.length) {
    return {
      mode: sourceMode,
      items,
      primary: 'none',
      warning: '还没有选择音源：请打开「系统声音」（对方在电脑里说话）或「麦克风」。',
    };
  }
  return {
    mode: sourceMode,
    items,
    primary: items[0].channel,
    warning: undefined,
  };
}
