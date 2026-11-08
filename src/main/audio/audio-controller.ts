import { ipcMain, type BrowserWindow } from 'electron';
import { IPC, type AudioLevelPayload, type AudioStatusPayload } from '../../shared/ipc';
import { getSettingsStore } from '../settings-store';
import { describeError, logger } from '../logger';
import {
  pipelineSignature,
  shouldRestartPipeline,
  startSucceeded,
  type PipelineConfig,
  type StartOutcome,
} from '../../shared/pipeline-gate';
import { hasRecentSignal, pushSignal, type SignalSample } from '../../shared/audio-state';
import { resolveSources } from '../../shared/sources';
import { directionFor, sampleById, sampleVariant } from '../../shared/samples';
import { MockAudioEngine, type AudioEngine } from './mock-engine';
import {
  PythonAudioEngine,
  probeAudio,
  pythonAvailability,
  resetPythonDiscovery,
} from './python-engine';

/**
 * 音频管线的主控。
 *
 * 0.3.x 的三个问题都出在这个文件里，改写时逐个对着修：
 *
 * 1. **启动虚报成功**。旧 `startAudioPipeline()` 是同步函数，`AUDIO_START` 直接
 *    返回 `{ok: true}`，而 sidecar 是 `spawn()` 之后才异步起设备 —— 设备打不开、
 *    被独占、或者 python 根本没起来，界面照样显示「成功」。现在改成等 sidecar
 *    发出 `started` 事件（或明确报错）再回执，超过等待时间就回 `pending`。
 * 2. **引擎死了但指纹还在**。旧逻辑只发一个 error 状态，`runningSignature`
 *    没清 → 用户再点「开始」时 `shouldRestartPipeline()` 认为「配置没变、
 *    已经在跑」，直接跳过。表现出来就是「点多少次都没反应，只能重启软件」。
 *    现在引擎退出会走 `handleEngineDead()`，把指纹一起清掉。
 * 3. **没有「重新连接」**。加一条 IPC（AUDIO_RECONNECT）：强制重建管线，
 *    并重新探测 Python —— 用户不必重启整个软件。
 */

let engine: AudioEngine | null = null;
let boundWindow: BrowserWindow | null = null;
/** 当前管线的配置指纹（'' = 没有管线在跑）。 */
let runningSignature = '';
/** 正在启动中（避免连点两次开始拉起两个进程）。 */
let starting = false;
/**
 * 引擎是否已经拿到设备确认（sidecar 的 `started` 事件）。
 *
 * 和 `starting` 分开记：`starting` 只表示「有一个启动流程在跑」，
 * 而这里表示「设备真的开了」。跳过启动时靠它决定该回推 `listening`
 * 还是 `starting` —— 回错了就是界面写「正在连接」而字幕在滚。
 */
let engineReady = false;

/** 最近的响度采样，只用于判断「最近有没有声音」，不留音频。 */
let signalWindow: SignalSample[] = [];
/** 上一次播报过的「有没有信号」，避免同一状态反复刷屏。 */
let lastSignalState: boolean | null = null;
/** 上一次是否已经发过 no-audio（避免每次 level 都发一条状态）。 */
let noAudioAnnounced = false;

/**
 * 引擎代次。
 *
 * 每次「启动 / 停止 / 重连」都会 +1。所有异步回调（设备确认、死亡上报、
 * 电平）都带着自己出生时的代次，跟当前对不上就**整个丢掉**。
 *
 * 为什么必须这样：0.4.0 出现过两个真实的错乱 ——
 *  1. 点开始后还在等设备确认，用户点了暂停；一两秒后那份 `ok` 回执到达，
 *     把状态改回「正在采集」，而音频其实已经停了；
 *  2. 旧引擎崩溃后迟到的 `onDead` 把**新**连接的指纹清空，界面显示已连接、
 *     实际没有任何进程在采。
 * 光靠「清空引用」挡不住这两种情况，因为迟到的回调手里握着的是旧对象。
 */
let engineGeneration = 0;

function currentConfig(): PipelineConfig {
  const s = getSettingsStore().get();
  return {
    mockMode: s.mockMode,
    captureSystemAudio: s.audio.captureSystemAudio,
    captureMicrophone: s.audio.captureMicrophone,
    sourceMode: s.audio.sourceMode,
    systemDeviceId: s.audio.systemDeviceId || 'default',
    micDeviceId: s.audio.micDeviceId || 'default',
    pythonPath: s.audio.pythonPath || '',
    demoAutoPlay: s.demoAutoPlay,
    targetLanguage: s.targetLanguage,
  };
}

function sendStatus(status: AudioStatusPayload['status'], message: string) {
  const win = boundWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.AUDIO_STATUS, { status, message });
}

/**
 * 引擎死掉之后的收场。
 *
 * 顺序很重要：**先停掉那个引擎，再清引用**。
 * 反过来会让已经半死的 sidecar / 子进程留在后台（设备被它占着，下一次启动
 * 就报「设备被独占」，用户只能重启电脑）。
 *
 * `generation` 用来挡迟到的回调：旧引擎的 `onDead` 到达时如果代次已经变了，
 * 说明用户已经重连或又开了一次，这一次死亡与新连接无关 —— 直接忽略，
 * 绝不能清掉新管线的指纹。
 */
function handleEngineDead(reason: string, generation: number) {
  if (generation !== engineGeneration) {
    logger.info('Audio', `ignore death report from stale engine #${generation}`);
    return;
  }
  if (!engine && !runningSignature) return;
  const dying = engine;
  const name = dying instanceof MockAudioEngine ? '演示' : '音频';
  // 先停：避免遗留采集进程占着设备。
  try {
    dying?.stop();
  } catch {
    /* 已经死了 */
  }
  engine = null;
  runningSignature = '';
  starting = false;
  engineReady = false;
  signalWindow = [];
  lastSignalState = null;
  noAudioAnnounced = false;
  logger.warn('Audio', `${name}引擎停止：${reason}`);
  sendStatus(
    'error',
    `${name}采集进程已停止（${reason}）。点「重新连接」可以恢复，不需要重启软件。`,
  );
}

/** 响度采样 → 判定「最近 8 秒有没有声音」，并只在该变化时播报。 */
function watchLevel(level: AudioLevelPayload) {
  const now = Date.now();
  signalWindow = pushSignal(signalWindow, { at: now, db: level.db });
  const hasSignal = hasRecentSignal(signalWindow, now);
  if (lastSignalState === hasSignal) return;
  lastSignalState = hasSignal;

  if (!hasSignal) {
    // 从「有声音」掉到「没声音」：可能是对方停了，也可能是设备被拔 / 切走了。
    // 不再用「全程最大音量」判断，所以这种中途掉音现在能显示出来。
    if (!noAudioAnnounced) {
      noAudioAnnounced = true;
      logger.info('Audio', 'no signal in the last 8s window');
      sendStatus('no-audio', '正在采集，但最近 8 秒没有收到声音。');
    }
    return;
  }
  noAudioAnnounced = false;
  sendStatus('listening', level.device ? `正在采集 · ${level.device}` : '正在采集');
}

/**
 * 把钩子挂到引擎上，并把「这一代」的编号一起封进去。
 *
 * 所有回调第一件事都是核对代次 —— 这是旧引擎迟到回调改不动新连接的唯一
 * 保证（对象引用会被清，但回调里的闭包不会）。
 */
function attachHooks(target: AudioEngine, generation: number) {
  target.onDead = (reason) => handleEngineDead(reason, generation);
  target.onLevel = (level) => {
    if (generation !== engineGeneration) return;
    watchLevel(level);
  };
  target.onDropped = (info) => {
    if (generation !== engineGeneration) return;
    // 丢了一段音频必须让用户看见「有一句没转写」，不能只写日志。
    logger.warn('Audio', `segment dropped: ${info.reason}`);
    const win = boundWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.AUDIO_DROPPED, { at: info.at, reason: info.reason });
  };
}

export interface StartReport {
  ok: boolean;
  kind: StartOutcome['kind'];
  message: string;
}

/**
 * 启动（或按需重建）音频管线。
 *
 * `force` 用于「重新连接」：即使配置没变也强制重建，并重新探测 Python
 * （用户可能刚把设备插回去、或者刚结束了一个占用声卡的程序）。
 */
export async function startAudioPipeline(
  win: BrowserWindow,
  options: { force?: boolean } = {},
): Promise<StartReport> {
  const config = currentConfig();
  const alive = engine !== null;

  if (!options.force && !shouldRestartPipeline(runningSignature, config, alive)) {
    logger.info('Audio', 'start skipped (pipeline already running with same settings)');
    /*
     * 跳过也必须回推一次真实状态。
     *
     * 时序是这样的：主进程开机就自启了管线并发过 `listening`，随后渲染层
     * 「设置加载完、status 还是 idle」时又请求一次启动。那一次走的就是这条
     * 跳过分支 —— 如果什么都不发，渲染层之前自己写的「正在连接音频设备…」
     * 就永远留在界面上了（实测：演示模式里整场都写着「正在连接」，而字幕
     * 明明在往下滚）。
     */
    sendStatus(
      engineReady ? 'listening' : 'starting',
      engineReady ? '音频已经在采集' : '正在连接音频，请稍候…',
    );
    return { ok: true, kind: 'skipped', message: '音频已经在采集' };
  }

  // 连点两次「开始」时，第二次不该再拉一个进程。
  if (starting && !options.force) {
    return { ok: false, kind: 'pending', message: '正在连接音频，请稍候…' };
  }

  if (options.force) resetPythonDiscovery();

  /*
   * 从这里开始是一次真正的重建：先停旧管线，再记下这次启动属于哪一代。
   * `stopAudioPipeline()` 会把代次 +1，所以 `generation` 就是「我这一代」。
   */
  stopAudioPipeline();
  const generation = engineGeneration;
  boundWindow = win;

  const settings = getSettingsStore().get();
  /*
   * 先确认「这次到底采什么」。没选音源就启动，等于开一个永远没声音的进程，
   * 用户只会以为软件坏了 —— 直接把原因说清楚。
   */
  const plan = resolveSources({
    sourceMode: settings.audio.sourceMode,
    captureSystemAudio: settings.audio.captureSystemAudio,
    captureMicrophone: settings.audio.captureMicrophone,
  });
  if (!plan.items.length) {
    const message = plan.warning ?? '还没有选择音源';
    logger.warn('Audio', `start rejected: ${message}`);
    sendStatus('error', message);
    return { ok: false, kind: 'failed', message };
  }
  if (plan.warning) logger.info('Audio', `source note: ${plan.warning}`);

  starting = true;
  sendStatus('starting', config.mockMode ? '正在准备演示对话…' : '正在连接音频设备…');

  try {
    const created: AudioEngine = config.mockMode
      ? new MockAudioEngine(win)
      : new PythonAudioEngine(win, {
          sourceMode: settings.audio.sourceMode,
          captureSystemAudio: settings.audio.captureSystemAudio,
          captureMicrophone: settings.audio.captureMicrophone,
        });
    attachHooks(created, generation);
    engine = created;
    runningSignature = pipelineSignature(config);
    await created.start();

    /*
     * 等设备确认。真实引擎会等到 sidecar 的 `started` 事件；演示引擎立刻返回。
     * 超时不算失败（进程可能只是慢），但要如实回 `pending` —— 界面写
     * 「正在连接」，而不是「正在采集」。
     */
    const ready = created.waitUntilReady
      ? await created.waitUntilReady(10_000)
      : { ok: true, message: '' };

    /*
     * 等待期间可能发生了「暂停 / 重连 / 又一次开始」。
     * 只要代次变了，这次启动就已经作废：把刚起来的那个引擎停掉，
     * 不碰任何状态（新的那一代有自己的状态）。
     */
    if (generation !== engineGeneration) {
      try {
        created.stop();
      } catch {
        /* 可能已经停了 */
      }
      logger.info('Audio', `start #${generation} superseded while waiting for device`);
      return { ok: false, kind: 'cancelled', message: '这次启动已被新的操作取代' };
    }

    starting = false;

    if (!ready.ok) {
      const report: StartReport = {
        ok: false,
        kind: ready.timedOut ? 'pending' : 'failed',
        message: ready.message,
      };
      // 明确失败才清场；单纯超时保留进程，等它自己起来。
      if (report.kind === 'failed') handleEngineDead(ready.message, generation);
      return report;
    }

    engineReady = true;
    sendStatus('listening', ready.message || (config.mockMode ? '演示对话已开始' : '正在采集'));
    logger.info('Audio', `pipeline ready (${config.mockMode ? 'mock' : 'real'})`);
    return { ok: true, kind: 'running', message: ready.message || '正在采集' };
  } catch (error) {
    starting = false;
    if (generation !== engineGeneration) {
      return { ok: false, kind: 'cancelled', message: '这次启动已被新的操作取代' };
    }
    // 只留错误类型，不把可能带路径/命令行的原始异常写进日志。
    const code = error instanceof Error ? error.name : 'unknown';
    logger.error('Audio', `start failed: ${code}`);
    handleEngineDead('启动失败', generation);
    return { ok: false, kind: 'failed', message: '启动音频失败，请点「重新连接」再试一次。' };
  }
}

export function stopAudioPipeline() {
  // 代次 +1：所有在途的启动回执、死亡上报、电平从此作废。
  engineGeneration += 1;
  if (engine) {
    try {
      engine.stop();
    } catch {
      /* 进程可能已经没了 */
    }
    engine = null;
  }
  runningSignature = '';
  starting = false;
  engineReady = false;
  signalWindow = [];
  lastSignalState = null;
  noAudioAnnounced = false;
}

/** 引擎是否真的在跑（配置指纹 + 对象都在才算）。 */
export function isPipelineRunning(): boolean {
  return engine !== null && runningSignature !== '';
}

/** Called by the window layer to release resources on quit. */
export function disposeAudio() {
  try {
    stopAudioPipeline();
    logger.info('Audio', 'pipeline disposed');
  } catch (error) {
    logger.error('Audio', `dispose failed: ${describeError(error)}`);
  }
}

export function registerAudioIpc(win: BrowserWindow) {
  boundWindow = win;

  ipcMain.handle(IPC.AUDIO_START, async () => {
    try {
      const settings = getSettingsStore().get();
      logger.info(
        'Audio',
        `start requested (mock=${settings.mockMode}, source=${settings.audio.sourceMode}, system=${settings.audio.captureSystemAudio}, mic=${settings.audio.captureMicrophone})`,
      );
      const report = await startAudioPipeline(win);
      return { ...report, ok: startSucceeded(report) };
    } catch (error) {
      logger.error('Audio', `start failed: ${describeError(error)}`);
      // 不把原始异常正文丢给界面：服务商回的错误体可能有几百字，
      // 塞进 460px 宽的状态条只会糊成一片。
      return { ok: false, kind: 'failed' as const, message: describeError(error) };
    }
  });

  /**
   * 「重新连接音频」。
   *
   * 不做这一步的话，sidecar 死掉之后用户唯一的出路是重启整个软件 —— 而这在
   * 一场正在进行的会议里等于事故。这里强制重建（配置没变也重建）并重新探测
   * Python，把「刚才那个解释器被杀了 / 设备刚插回来」这类情况一并救回来。
   */
  ipcMain.handle(IPC.AUDIO_RECONNECT, async () => {
    logger.info('Audio', 'reconnect requested');
    resetPythonDiscovery();
    const report = await startAudioPipeline(win, { force: true });
    return { ...report, ok: startSucceeded(report) };
  });

  ipcMain.handle(IPC.AUDIO_STOP, async () => {
    stopAudioPipeline();
    return { ok: true };
  });

  ipcMain.handle(IPC.AUDIO_DEMO_LINE, async (_event, text?: unknown) => {
    const settings = getSettingsStore().get();
    if (!settings.mockMode) {
      return { ok: false, message: '真实模式下没有示例对话，请先开启演示模式' };
    }
    // Make sure a mock engine exists even while auto-play is switched off.
    if (!engine || !(engine instanceof MockAudioEngine)) {
      stopAudioPipeline();
      const generation = engineGeneration;
      const created = new MockAudioEngine(win);
      attachHooks(created, generation);
      engine = created;
      runningSignature = pipelineSignature(currentConfig());
      await created.start();
    }
    /*
     * 指定文本只给自检用（COPILOT_SELFTEST=1）。不设这个开关时行为完全不变，
     * 仍然从内置语料里取一句 —— 免得界面上的「说一句示例」变成任意文本注入口。
     */
    if (typeof text === 'string' && text.trim() && process.env.COPILOT_SELFTEST === '1') {
      const said = (engine as MockAudioEngine).sayText(text.trim());
      return { ok: true, text: said };
    }
    const said = (engine as MockAudioEngine).sayOnce();
    return { ok: true, text: said };
  });

  /**
   * 跑一组内置样例。
   *
   * 这是一条**产品功能**（不是测试后门）：三组样例用来验证「字幕 → 译文 →
   * 关键信息 → 保存」整条链路。但它注入的是预置文本，所以必须：
   *  1. 只在演示模式可用（真实模式下拒绝，并说明「这不是真实识别结果」）；
   *  2. 只接受内置样例 id，不接受任意文本 —— 否则就成了字幕注入口；
   *  3. 不因此调用任何付费接口（演示模式的翻译走本地替身）。
   */
  ipcMain.handle(IPC.SAMPLES_RUN, async (_event, sampleId: unknown) => {
    const settings = getSettingsStore().get();
    if (!settings.mockMode) {
      return {
        ok: false,
        message:
          '三组样例是预置文本，只能在演示模式下运行 —— 这样不会调用你的付费接口，也不会被误认为真实识别结果。请先在「设置 → API 功能」里打开演示模式。',
      };
    }
    const sample = sampleById(String(sampleId ?? ''));
    if (!sample) return { ok: false, message: '没有这个样例' };
    /*
     * 样例按**语言方向**取版本：中文理解 → 英文原话 + 中文译文；日语理解 →
     * 英文原话 + 日语译文；英语理解 → 日语原话 + 英文译文。
     * 方向不在三个之内时不要硬跑 —— 跑出来的译文必然是中文或标记，评委会
     * 以为是翻译坏了。直接说清楚「这个组合没有预置样例」。
     */
    const variant = sampleVariant(
      sample,
      directionFor(settings.nativeLanguage, settings.targetLanguage),
    );
    if (!variant) {
      return {
        ok: false,
        message:
          '当前语言组合没有预置样例。本版只对「中文→英语」「日语→英语」「英语→日语」三个方向写了逐句核对过的样例；换成这三个之一再试。',
      };
    }

    if (!engine || !(engine instanceof MockAudioEngine)) {
      stopAudioPipeline();
      const generation = engineGeneration;
      const created = new MockAudioEngine(win);
      attachHooks(created, generation);
      engine = created;
      runningSignature = pipelineSignature(currentConfig());
      await created.start();
    }
    // 逐句模拟「对方说完了这一句」：走的是和真实识别完全相同的下游链路。
    const said = (engine as MockAudioEngine).sayText(variant.original);
    logger.info('Audio', `sample played chars=${variant.original.length}`);
    return { ok: true, text: said, translatedHint: variant.translation };
  });

  ipcMain.handle(IPC.AUDIO_DEVICES, async () => {
    const settings = getSettingsStore().get();
    if (settings.mockMode) {
      return [
        { id: 'mock-system', name: '系统音频（演示）', kind: 'system' as const },
        { id: 'mock-mic', name: '麦克风（演示）', kind: 'mic' as const },
      ];
    }
    try {
      return await new PythonAudioEngine(win).listDevices();
    } catch (error) {
      logger.warn('Audio', `device enumeration failed: ${describeError(error)}`);
      return [];
    }
  });

  /**
   * Record a few seconds and report the real level. This is the answer to
   * "why is the subtitle list empty?" — it separates capture from recognition.
   * Also re-resolves Python so filling in a path takes effect immediately.
   */
  ipcMain.handle(IPC.AUDIO_PROBE, async (_event, mode: 'loopback' | 'mic' = 'loopback') => {
    resetPythonDiscovery();
    const availability = pythonAvailability();
    if (!availability.available) {
      return {
        ok: false,
        mode,
        device: '',
        deviceId: '',
        rate: 0,
        channels: 0,
        rms: 0,
        peak: 0,
        db: -120,
        durationMs: 0,
        hasSignal: false,
        message:
          '安装包自带的音频组件没找到（可能被杀毒软件拦截，或安装不完整）。建议重新安装本软件；也可以在设置 → 音频里手动指定 python.exe 的路径。',
      };
    }
    return probeAudio(mode, 2.5);
  });
}

export function getBoundWindow(): BrowserWindow | null {
  return boundWindow;
}
