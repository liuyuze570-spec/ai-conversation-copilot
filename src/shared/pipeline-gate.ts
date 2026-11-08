/**
 * 「要不要重建音频管线」的纯判定。
 *
 * 背景：启动请求有两个来源 —— 主进程开机自动启动，和渲染层「设置加载完、
 * 状态还是 idle」时自己再启动一次。两者必然在开机那 1 秒内撞在一起。
 * 无脑 stop→start 的后果是每次开机都白起一个 python 采集进程再杀掉它，
 * 日志里出现两条 `loopback stream started`、会话号从 1 跳到 3。
 *
 * 这里把「配置是否真的变了」做成纯函数，好让 `reliability-unit` 直接测，
 * 而不是靠读日志猜。
 */

export interface PipelineConfig {
  mockMode: boolean;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
  /**
   * 音源用途（线上交流 / 现场沟通）。
   *
   * 必须进指纹：它决定麦克风收到的声音算「对方」还是「你」，也就决定了
   * 要不要翻译。0.4.0 漏了它，于是「线上 ↔ 现场」只改了界面文字 ——
   * 引擎还是那一个，路由还是老路由，用户切过去以后对方说的话依然不翻译。
   */
  sourceMode: 'online' | 'onsite';
  systemDeviceId: string;
  micDeviceId: string;
  pythonPath: string;
  /** 仅演示模式有意义：示例对话是否自动播放 */
  demoAutoPlay: boolean;
  /** 仅演示模式有意义：示例对话用哪种语言 */
  targetLanguage: string;
}

/**
 * 配置指纹。字段顺序即语义顺序，改动请同步 `.dev/reliability-unit.mjs`
 * 与 `.dev/competition-unit.mjs`。
 *
 * 刻意**不**包含 sttProvider：识别服务商是每次调用现取的，换服务商不需要
 * 拆掉采集，拆了反而会丢当前这段正在录的音频。
 */
export function pipelineSignature(config: PipelineConfig): string {
  const parts = [
    config.mockMode ? 'mock' : 'real',
    config.captureSystemAudio ? 'sys' : '-',
    config.captureMicrophone ? 'mic' : '-',
    /*
     * 用途只有在「真的会用到麦克风」时才影响采集：
     * 只采系统声音时，改用途不会改变任何一路的 speaker 路由，
     * 也就不该为此重建一次进程（那会白丢半秒音频）。
     */
    config.captureMicrophone ? (config.sourceMode === 'onsite' ? 'onsite' : 'online') : '-',
    config.systemDeviceId || 'default',
    config.micDeviceId || 'default',
    config.pythonPath || '',
  ];
  /*
   * 演示模式的「示例对话 / 目标语言」由引擎自己排期，换了必须重建；
   * 真实模式不依赖它们，所以只在 mock 下计入 —— 否则改个语言就把正在
   * 采集的系统声音拆掉了。
   */
  if (config.mockMode) {
    parts.push(config.demoAutoPlay ? 'auto' : 'manual', config.targetLanguage);
  }
  return parts.join('|');
}

/**
 * 已经有管线在跑、且配置没变 → 这次启动请求什么都不用做。
 * `running` 为空表示当前没有管线（已停止），必须重新启动。
 *
 * `alive` 是 0.4.0 补的一道保险：配置指纹只说明「上次启动时的设置」，
 * 说明不了「那个进程现在还活着」。音频进程被拔设备、被杀毒软件结束、
 * 或者自己崩掉之后，指纹还在 —— 旧逻辑据此认为「已经在跑」，
 * 直接跳过重启，于是用户怎么点「开始」都没有声音。
 * 引擎一死就必须连带把指纹清掉（见 audio-controller），这里再用 alive
 * 兜一道，保证两处都不会漏。
 */
export function shouldRestartPipeline(
  running: string,
  config: PipelineConfig,
  alive = true,
): boolean {
  if (!running) return true;
  if (!alive) return true;
  return running !== pipelineSignature(config);
}

/** 启动请求的真实结果（不是「我把函数调完了」）。 */
export type StartOutcome =
  | { kind: 'running'; message: string }
  | { kind: 'skipped'; message: string }
  | { kind: 'pending'; message: string }
  /** 这次启动在等待过程中被「暂停 / 重连 / 再点一次开始」取代了。 */
  | { kind: 'cancelled'; message: string }
  | { kind: 'failed'; message: string };

/**
 * 启动回执要不要报成功。
 *
 * 只有 `running` / `skipped` 才算成功。`pending` 是「进程起来了但设备还没
 * 确认」—— 这时候如果回 ok:true，界面就会显示「正在采集」，而实际上一个字幕
 * 都出不来，用户只能反复点开始。宁可说「还在连接」，也不要虚报。
 * `cancelled` 表示这次请求已经作废：界面既不该算成功，也不该报错。
 */
export function startSucceeded(outcome: StartOutcome): boolean {
  return outcome.kind === 'running' || outcome.kind === 'skipped';
}
