/** IPC channel names shared between main and renderer. */
export const IPC = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  KEY_GET: 'key:get',
  /** 只回传脱敏后的 Key 状态，不回传完整 Key。 */
  KEY_PREVIEW: 'key:preview',
  KEY_SET: 'key:set',
  KEY_HAS: 'key:has',
  LOG: 'log:write',
  LOG_TAIL: 'log:tail',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_SET_OPACITY: 'window:set-opacity',
  WINDOW_SET_ALWAYS_ON_TOP: 'window:set-always-on-top',
  WINDOW_SET_LOCKED: 'window:set-locked',
  WINDOW_SET_SIZE: 'window:set-size',
  WINDOW_RESET_POSITION: 'window:reset-position',
  TRAY_TOGGLE_LISTENING: 'tray:toggle-listening',
  SHORTCUT_EVENT: 'shortcut:event',
  AUDIO_STATUS: 'audio:status',
  AUDIO_TRANSCRIPT: 'audio:transcript',
  AUDIO_LEVEL: 'audio:level',
  AUDIO_DEVICES: 'audio:devices',
  AUDIO_START: 'audio:start',
  /** 强制重建音频管线（引擎死了 / 换了设备 / 刚插回耳机）。 */
  AUDIO_RECONNECT: 'audio:reconnect',
  AUDIO_STOP: 'audio:stop',
  AUDIO_DEMO_LINE: 'audio:demo-line',
  AUDIO_PROBE: 'audio:probe',
  /** 丢了一段音频 —— 界面要在字幕流里留一个「这里少了一句」的标记。 */
  AUDIO_DROPPED: 'audio:dropped',
  /**
   * 一键体检：音频组件 / 设备 / 电平 / 采集开关 / Key / 模型一起查一遍。
   *
   * 和 `AUDIO_PROBE` 的区别：probe 只回答「这 2.5 秒有没有声音」，体检回答
   * 「到底哪一项挡着出字幕」。结果里 `ok` 的项界面不显示。
   */
  SYSTEM_CHECK: 'system:check',
  /** 真实请求一次模型，验证「地址 + Key + 模型」是否对。 */
  AI_TEST: 'ai:test',
  /** 拉取服务商的模型列表（用于下拉选择）。 */
  AI_MODELS: 'ai:models',
  /** 当前配了哪些 Key（文字 / 语音识别），用于界面状态显示。 */
  AI_KEY_INFO: 'ai:key-info',
  /**
   * 取消一个在途的 AI 请求（翻译 / 回复 / 朗读）。
   *
   * 停止监听、切换会话、关掉回复面板、或者被新请求替代时，界面会发这个通道，
   * 主进程据此 abort 底层 HTTP —— 不是「跑完了再把结果丢掉」。后者既白烧额度，
   * 又会出现「已经标成 cancelled 的字幕被迟到结果改回 ok」。
   */
  AI_CANCEL: 'ai:cancel',
  /**
   * 从一句**定稿**字幕里提取关键事实（时间/地点/金额/人名/事项…）。
   *
   * 规则能认的数字类由界面本地直接算，这个通道只补规则做不了的（人名、组织、
   * 待办、负责人）。失败不影响字幕和翻译，调用方按「没提取到」处理。
   */
  FACTS_EXTRACT: 'facts:extract',
  /** 把选中的几条事实写成一句自然的确认用语（+ 中文意思）。 */
  AI_CONFIRM: 'ai:confirm',
  /** 打开随软件附带的教学文档。 */
  DOC_OPEN: 'doc:open',
  /**
   * 全链路时延：主进程采集完一段就推给界面。
   *
   * 没有这个之前，「到底慢在哪一段」只能靠猜 —— 演示模式是本地 mock，
   * 毫秒返回，看起来一切正常；真实 Key 之下的瓶颈完全看不见。
   */
  LATENCY_PUSH: 'latency:push',
  LATENCY_GET: 'latency:get',
  LATENCY_CLEAR: 'latency:clear',
  /**
   * 真实识别测速：自己合成一段音频打给真实的识别接口，量一次往返。
   *
   * 实时字幕的体验上限就是这段耗时。真实数字本来只有「有 Key + 有音频」时才拿得到，
   * 而这两件事用户未必同时具备 —— 所以给一个不依赖声卡的主动测速入口。
   */
  LATENCY_PROBE_STT: 'latency:probe-stt',
  /**
   * 聊天记录的长期保存（主进程 SQLite）。
   *
   * 拆成这么多通道而不是「一条大 JSON」的原因：写、翻页、搜索、导出是四种
   * 完全不同的负载。写要小批量高频，翻页只取一页，搜索要全库，导出可能几十
   * 万条 —— 混在一起，任何一项变慢都会拖住另外三项。
   */
  HISTORY_STATUS: 'history:status',
  /** 建立（或取回）一个会话。会话 id 在第一条字幕之前就固定。 */
  HISTORY_ENSURE_SESSION: 'history:ensure-session',
  /** 批量写入 / 更新消息（同一 id 覆盖同一行）。 */
  HISTORY_UPSERT: 'history:upsert',
  HISTORY_LIST: 'history:list',
  HISTORY_PAGE: 'history:page',
  HISTORY_SEARCH: 'history:search',
  HISTORY_RENAME: 'history:rename',
  HISTORY_DELETE: 'history:delete',
  /** 清空全部历史 —— 只有用户明确确认才会发。 */
  HISTORY_CLEAR: 'history:clear',
  HISTORY_EXPORT: 'history:export',
  HISTORY_BACKUP: 'history:backup',
  HISTORY_OPEN_FOLDER: 'history:open-folder',
  /** 关键信息卡的结果也要落盘，否则打开旧记录时信息会缺一块。 */
  HISTORY_SAVE_FACTS: 'history:save-facts',
  /**
   * 跑一组内置样例（三句：时间 / 否定改期 / 金额纠正）。
   *
   * 只在演示模式下有效：它会**注入预置文本**，不是真实识别。真实模式下直接
   * 拒绝并说明原因 —— 否则用户会以为这是「真实的语音识别结果」，而它只是
   * 界面流程的证明。也绝不因此调用付费接口。
   */
  SAMPLES_RUN: 'samples:run',
} as const;

export type ShortcutAction =
  | 'reply'
  | 'didnt-catch'
  | 'continue'
  | 'toggle-pause'
  | 'close-replies'
  | 'toggle-video';

export interface AudioStatusPayload {
  /** `starting` = 进程起来了、设备还没确认（界面不许写成「正在采集」）。 */
  status: 'idle' | 'starting' | 'listening' | 'paused' | 'no-audio' | 'error';
  message?: string;
}

/** 一段音频没被转写（积压丢弃 / 识别超时 / 识别失败）。 */
export interface AudioDroppedPayload {
  /** 大致发生时间，用来在字幕流里按顺序插入标记。 */
  at: number;
  reason: string;
}

/** Transcript event pushed from the main process audio pipeline. */
export interface TranscriptPayload {
  speaker: 'foreign' | 'user';
  text: string;
  partial: boolean;
  confidence?: number;
  /**
   * 这一轮识别的时延埋点 id。
   *
   * 界面把它原样带回翻译请求，主进程才能把「识别」和「翻译」两段耗时合成
   * 一轮真正的端到端数字。没有它就只能各段分开看。
   */
  traceId?: string;
  /**
   * 这条字幕属于第几次「开始监听」。
   *
   * 停止监听 / 重新开始时会换成新的编号。界面只接受不比当前更新的编号，
   * 于是「停止 → 重新开始」之后，上一轮还在路上的识别结果不会混进来 ——
   * 那是旧音频转出来的字幕，出现在新一场对话里就是错的内容。
   */
  sessionId?: number;
}

/**
 * Live loudness of what is being captured. This is what proves the app can
 * actually hear the computer, so the UI can distinguish
 * "nothing is playing" from "the recogniser is unhappy".
 */
export interface AudioLevelPayload {
  /** 0..1 RMS of the most recent block. */
  rms: number;
  peak: number;
  db: number;
  /** True while the level is loud enough to look like speech. */
  speaking: boolean;
  /** Total seconds of audio captured since the stream started. */
  capturedSeconds: number;
  source: 'system' | 'mic';
  device: string;
}

export interface AudioProbeResult {
  ok: boolean;
  mode: 'loopback' | 'mic';
  device: string;
  deviceId: string;
  rate: number;
  channels: number;
  rms: number;
  peak: number;
  db: number;
  durationMs: number;
  hasSignal: boolean;
  attempts?: string[];
  message?: string;
  /**
   * 默认播放设备的音量（0..1）与静音标志，读不到就没有这两个字段。
   *
   * 报出来是为了让用户**不必怀疑它**：实测证明 WASAPI 回环的取样点在端点音量 /
   * 静音之前，所以「电脑静音」根本不影响采集。用户看到自己静音了却仍在出字幕，
   * 就不会再把「没字幕」归罪于静音。
   */
  systemVolume?: number;
  systemMute?: boolean;
}

/** 「测试连接」的结果：不仅说成不成功，还说清卡在哪一步。 */
export interface AiTestResult {
  ok: boolean;
  /** 卡在哪一步：地址校验 / Key / 真实对话请求 / 模型列表 / 全部通过。 */
  stage: 'url' | 'key' | 'chat' | 'models' | 'done';
  /** 一句话结论（界面主标题）。 */
  title: string;
  /** 怎么办（界面副标题）。 */
  hint: string;
  /** 原始错误，折叠显示。 */
  raw?: string;
  latencyMs?: number;
  model?: string;
  /** 模型返回的那句话，证明真的通了。 */
  reply?: string;
  /** 实际请求的完整地址。 */
  endpoint?: string;
  /** 服务商返回的可用模型列表（可能为空）。 */
  models?: string[];
}

/** 主动测一次「真实语音识别」的往返耗时。 */
export interface SttLatencyProbe {
  ok: boolean;
  /** 真实往返耗时（毫秒）。 */
  ms: number;
  /** 送过去的音频有多长（毫秒）。实时率 = ms ÷ audioMs。 */
  audioMs: number;
  /** 实际用的识别模型。 */
  model: string;
  /** 识别返回的字符数。发的是合成音，通常是 0，不影响计时。 */
  chars: number;
  message?: string;
}

export interface AiKeyInfo {
  /** 是否已保存文字模型（LLM）的 Key。 */
  llm: boolean;
  /** 是否已保存语音识别（STT）的 Key。 */
  stt: boolean;
  /** STT 与 LLM 用同一台服务器，可以共用一把 Key。 */
  sttShared: boolean;
  /** 综合判断：字幕现在能不能工作。 */
  sttReady: boolean;
  /** 系统加密是否可用（不可用时 Key 只在内存里，重启要重填）。 */
  encrypted: boolean;
  /** 现在存在「只在本次运行有效」的 Key（界面要提示）。 */
  ephemeral: boolean;
  /**
   * 已保存的 Key 属于另一家服务商。
   *
   * 切换服务商后会出现：Key 还在，但为了不把它发给新服务商，发送时被拦下来了。
   * 界面据此提示「请重新粘贴这家的 Key」，而不是干巴巴一条 401。
   */
  mismatch: boolean;
  /**
   * 有 Key，但没有任何归属记录（早期版本留下的 / 设置文件被手工改过）。
   *
   * 归属未知的 Key 同样**不会**被发送 —— 界面提示重新粘贴。
   */
  unknown: boolean;
}

/** 随软件附带的教学文档。 */
export type DocKind = 'tutorial' | 'readme';

export interface OpenDocResult {
  ok: boolean;
  path?: string;
  message?: string;
}
