import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  protocol,
  net,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC, type DocKind, type ShortcutAction } from '../shared/ipc';
import type { LogLevel, Settings } from '../shared/types';
import { checkDomesticURL } from '../shared/providers';
import { levelFor } from '../shared/levels';
import { docFileUrl } from './doc-link';
import { registerHistoryIpc } from './history-ipc';
import { runV050SelfCheck } from './selftest-v050';
import { runV060SelfCheck } from './selftest-v060';
import { runV061RestartCheck } from './selftest-v061';
import { runV063CaptureCheck } from './selftest-v063';
import { closeHistoryStore } from './history-db';
import {
  createOverlayWindow,
  getOverlayWindow,
  resetOverlayPosition,
} from './overlay-window';
import {
  setOverlayAlwaysOnTop,
  setOverlayLocked,
  setOverlayOpacity,
} from './overlay-window';
import { getSettingsStore } from './settings-store';
import { describeError, logger } from './logger';
import {
  disposeAudio,
  startAudioPipeline,
} from './audio/audio-controller';
import { pythonAvailability } from './audio/python-engine';
import { runSystemCheck } from './audio/health-check';
import {
  fetchModelList,
  getLLM,
  getSTT,
  keyInfo,
  probeSttLatency,
  synthesizeSpeech,
  testAIConnection,
  translateText,
} from './ai-service';
import { composeConfirmation, extractFactsWithModel, toItems } from './facts-service';
import { createTray, destroyTray } from './tray';
import {
  clearLatency,
  latencySnapshot,
  onLatencyChange,
  recordProbe,
  recordReply,
  recordTranslate,
} from './latency';
import { describeAiError, toUserError } from '../shared/ai-errors';
import { sttLanguageCode } from '../shared/types';

const SHORTCUTS: Record<string, ShortcutAction> = {
  'Alt+Space': 'reply',
  'Alt+R': 'didnt-catch',
  'Alt+Q': 'continue',
  'Alt+P': 'toggle-pause',
  'Alt+X': 'close-replies',
  'Alt+V': 'toggle-video',
};

function emitShortcut(action: ShortcutAction) {
  const win = getOverlayWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IPC.SHORTCUT_EVENT, action);
}

/** 随软件一起分发的教学文档。打包后在 resources/docs，开发时在项目 docs/。 */
const TUTORIAL_FILE = '新手连接免费模型教程.html';

function resolveDocPath(kind: DocKind): string | null {
  const candidates =
    kind === 'tutorial'
      ? [
          path.join(process.resourcesPath, 'docs', TUTORIAL_FILE),
          path.join(app.getAppPath(), 'docs', TUTORIAL_FILE),
          path.join(__dirname, '../../docs', TUTORIAL_FILE),
        ]
      : [path.join(app.getAppPath(), 'README.md'), path.join(process.resourcesPath, 'README.md')];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * 只允许国内接口。
 *
 * 在写入设置之前把关：只要用户（或任何代码）想把模型地址改成境外的，
 * 直接拒绝并说明原因。渲染层也会先校验一次，这里是最后一道闸门。
 */
function validateDomesticPatch(
  patch: Partial<Settings>,
): { ok: true } | { ok: false; message: string } {
  const ai = patch.ai;
  if (!ai) return { ok: true };
  const fields: [string, string | undefined][] = [
    ['接口地址', ai.baseURL],
    ['语音识别地址', ai.sttBaseURL],
  ];
  for (const [label, value] of fields) {
    if (value === undefined || value === '') continue;
    const result = checkDomesticURL(value);
    if (!result.ok) {
      return { ok: false, message: `${label}不被允许：${result.reason ?? ''}` };
    }
  }
  return { ok: true };
}

function registerShortcuts() {
  for (const [accelerator, action] of Object.entries(SHORTCUTS)) {
    let ok = globalShortcut.register(accelerator, () => {
      logger.info('Shortcut', `${accelerator} -> ${action}`);
      emitShortcut(action);
    });
    // Some accelerators are grabbed by other apps; retry with Ctrl variant.
    if (!ok && accelerator.startsWith('Alt+')) {
      const fallback = `CommandOrControl+${accelerator}`;
      ok = globalShortcut.register(fallback, () => {
        logger.info('Shortcut', `${fallback} -> ${action}`);
        emitShortcut(action);
      });
      if (ok) {
        logger.warn('Shortcut', `${accelerator} busy, using ${fallback} instead`);
        continue;
      }
    }
    if (!ok) logger.warn('Shortcut', `failed to register ${accelerator}`);
  }
}

/**
 * 只接受「本应用自己的页面」发来的敏感 IPC。
 *
 * 为什么需要：`contextBridge` 只隔离了对象，不区分来源。窗口里只要有一段
 * 被注入的脚本（不管是别的页面被拖进来，还是某个第三方库拉了个 iframe），
 * 都能直接 `window.copilot.setApiKey(...)` / `aiReply(...)` —— 前者能改掉
 * 用户的 Key，后者能拿用户的钱去打模型。
 *
 * 规则：必须是**主 frame**，且地址落在「打包后的 copilot://」或「开发时的
 * localhost dev server」。其余一律拒绝并记日志。
 */
function isTrustedSender(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): boolean {
  const frame = event.senderFrame;
  if (!frame) return false;
  // 子 frame（iframe）一律不认，哪怕它和主页同源。
  if (frame.parent) return false;
  const url = frame.url || '';
  if (url.startsWith('copilot://')) return true;
  if (url.startsWith('file://')) return true;
  if (!app.isPackaged && /^https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(url)) return true;
  return false;
}

/** 给 `ipcMain.handle` 套上来源校验。 */
function guarded<Args extends unknown[], R>(
  name: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: Args) => R,
) {
  return (event: Electron.IpcMainInvokeEvent, ...args: Args): R => {
    if (!isTrustedSender(event)) {
      logger.warn('IPC', `rejected ${name} from ${event.senderFrame?.url ?? 'unknown'}`);
      throw new Error('UNTRUSTED_SENDER');
    }
    return handler(event, ...args);
  };
}

function registerIpc() {
  const store = getSettingsStore();

  ipcMain.handle(IPC.SETTINGS_GET, guarded(IPC.SETTINGS_GET, () => store.get()));

  ipcMain.handle(
    IPC.SETTINGS_SET,
    guarded(IPC.SETTINGS_SET, (_event, patch: Partial<Settings>) => {
      const check = validateDomesticPatch(patch);
      if (!check.ok) {
        logger.warn('Settings', `rejected settings patch: ${check.message}`);
        throw new Error(check.message);
      }
      const updated = store.update(patch);
      // 记下改了哪些字段——排查「设置莫名其妙变了」时全靠它。
      logger.info('Settings', `settings updated (${Object.keys(patch).join(',') || 'empty'})`);
      return updated;
    }),
  );

  /*
   * 密钥：渲染层只能拿到「脱敏预览」。
   *
   * `KEY_GET` 保留下来只为兼容旧调用点，返回值同样是预览 —— 任何路径都
   * 不再把完整 Key 交给页面。
   */
  const preview = (target: 'llm' | 'stt' = 'llm') => store.keyStatus(target);
  ipcMain.handle(IPC.KEY_PREVIEW, guarded(IPC.KEY_PREVIEW, (_event, target) =>
    preview(target ?? 'llm'),
  ));
  ipcMain.handle(IPC.KEY_GET, guarded(IPC.KEY_GET, (_event, target) =>
    preview(target ?? 'llm'),
  ));
  ipcMain.handle(IPC.KEY_HAS, guarded(IPC.KEY_HAS, (_event, target) =>
    store.hasApiKey(target ?? 'llm'),
  ));
  ipcMain.handle(IPC.KEY_SET, guarded(IPC.KEY_SET, (_event, value: string, target) =>
    store.setApiKey(typeof value === 'string' ? value : '', target ?? 'llm'),
  ));

  // ---- AI 配置：状态 / 真实连通性测试 / 模型列表 ----------------------------
  ipcMain.handle(IPC.AI_KEY_INFO, guarded(IPC.AI_KEY_INFO, () => keyInfo()));
  // 「一键诊断」：一次把音频、设备、Key、模型全查了。界面只显示有问题的项。
  ipcMain.handle(
    IPC.SYSTEM_CHECK,
    guarded(IPC.SYSTEM_CHECK, async () => {
      try {
        return await runSystemCheck();
      } catch (error) {
        logger.error('Audio', `system check failed: ${describeError(error)}`);
        return {
          checkedAt: Date.now(),
          items: [
            {
              id: 'crash',
              level: 'fail' as const,
              title: '检查没能跑完',
              // 诊断结果是要给用户看的，但不能把服务商返回的整段错误体
              // 甩上来（可能含请求回显）。describeError 只留错误码/错误名。
              detail: describeError(error),
              fix: '重新点一次诊断；还不行就重装本软件。',
            },
          ],
        };
      }
    }),
  );
  ipcMain.handle(IPC.AI_TEST, guarded(IPC.AI_TEST, () => testAIConnection()));
  ipcMain.handle(IPC.AI_MODELS, guarded(IPC.AI_MODELS, () => fetchModelList()));

  ipcMain.handle(
    IPC.DOC_OPEN,
    guarded(IPC.DOC_OPEN, async (_event, kind: DocKind = 'tutorial', anchor?: string) => {
    const docPath = resolveDocPath(kind);
    if (!docPath) {
      logger.warn('Doc', `document not found: ${kind}`);
      return { ok: false, message: '没有找到教程文件，请重新安装本软件' };
    }
    // 带 anchor 时用 openExternal：只有它能带 #片段，浏览器会直接滚到那一节。
    // 失败就退回 openPath —— 宁可打开整篇，也不能让按钮点了没反应。
    if (anchor) {
      const target = docFileUrl(docPath, anchor);
      try {
        await shell.openExternal(target);
        logger.info('Doc', `opened ${target}`);
        return { ok: true, path: docPath };
      } catch (error) {
        logger.warn('Doc', `openExternal with anchor failed: ${String(error)}`);
      }
    }
    const error = await shell.openPath(docPath);
    if (error) {
      logger.error('Doc', `openPath failed: ${error}`);
      return { ok: false, path: docPath, message: error };
    }
    logger.info('Doc', `opened ${docPath}`);
    return { ok: true, path: docPath };
    }),
  );

  ipcMain.on(IPC.LOG, (_event, level: LogLevel, scope: string, message: string) => {
    logger.info(scope, `[renderer:${level}] ${message}`);
  });
  ipcMain.handle(IPC.LOG_TAIL, (_event, count: number) => logger.tail(count ?? 100));

  ipcMain.on(IPC.WINDOW_MINIMIZE, () => {
    const win = getOverlayWindow();
    if (win && !win.isDestroyed()) {
      // Keep the tray entry as the way back when minimized.
      win.minimize();
    }
  });
  ipcMain.on(IPC.WINDOW_RESET_POSITION, () => resetOverlayPosition());
  ipcMain.on(IPC.WINDOW_CLOSE, () => {
    disposeAudio();
    app.quit();
  });
  ipcMain.on(IPC.WINDOW_SET_OPACITY, (_event, opacity: number) => setOverlayOpacity(opacity));
  ipcMain.on(IPC.WINDOW_SET_ALWAYS_ON_TOP, (_event, enabled: boolean) =>
    setOverlayAlwaysOnTop(enabled),
  );
  ipcMain.on(IPC.WINDOW_SET_LOCKED, (_event, locked: boolean) => setOverlayLocked(locked));
  ipcMain.on(IPC.WINDOW_SET_SIZE, (_event, width: number, height: number) => {
    const win = getOverlayWindow();
    if (win && !win.isDestroyed()) {
      const min = win.getMinimumSize();
      win.setSize(Math.max(min[0], width), Math.max(min[1], height));
    }
  });

  /*
   * 在途 AI 请求登记表。
   *
   * key 是界面给的 requestId（翻译用 `tr:<itemId>:<seq>`，回复用序号，
   * 朗读用 `tts:<seq>`）。界面取消时按 id 精确 abort —— 不能「全掐」，
   * 否则用户点「重试这一句」会把旁边那一句正常的翻译也一起弄死。
   */
  const aiInflight = new Map<string, AbortController>();

  function trackAiRequest(requestId: unknown): AbortController {
    const controller = new AbortController();
    if (typeof requestId === 'string' && requestId) {
      // 同 id 又来一次（重试）：让旧的那次先失效，避免两个请求抢同一行字幕。
      aiInflight.get(requestId)?.abort();
      aiInflight.set(requestId, controller);
    }
    return controller;
  }

  function untrackAiRequest(requestId: unknown, controller: AbortController): void {
    if (typeof requestId === 'string' && aiInflight.get(requestId) === controller) {
      aiInflight.delete(requestId);
    }
  }

  ipcMain.handle(
    IPC.AI_CANCEL,
    guarded(IPC.AI_CANCEL, (_event, requestIds: unknown) => {
      const list = Array.isArray(requestIds) ? requestIds : [requestIds];
      let cancelled = 0;
      for (const id of list) {
        if (typeof id !== 'string') continue;
        const controller = aiInflight.get(id);
        if (!controller) continue;
        aiInflight.delete(id);
        try {
          controller.abort();
          cancelled += 1;
        } catch {
          /* 已经结束了 */
        }
      }
      return { cancelled };
    }),
  );

  ipcMain.handle(
    'ai:translate',
    guarded(
      'ai:translate',
      async (_event, text: string, context: string[] = [], traceId?: string, requestId?: string) => {
        const started = Date.now();
        const controller = trackAiRequest(requestId);
        try {
          const translated = await translateText(
            typeof text === 'string' ? text : '',
            Array.isArray(context) ? context.filter((item) => typeof item === 'string') : [],
            { signal: controller.signal },
          );
          // 把这一段耗时补回那一轮识别记录上，拼出真正的端到端。
          // traceId 由界面从字幕事件里带回来（见 TranscriptPayload.traceId）。
          recordTranslate(traceId, Date.now() - started);
          if (!translated.trim()) {
            /*
             * 服务商「成功」但内容为空：可能是被内容过滤、也可能是模型坏了。
             * 这不能当成成功写回字幕 —— 空译文在界面上等于「翻译没了」。
             */
            return {
              ok: false,
              text: '',
              error: {
                code: 'empty',
                title: '服务商没有返回译文',
                hint: '再点这一句的「重试」；如果一直为空，换一个模型或在「设置 → API 功能」里点测试连接。',
              },
            };
          }
          return { ok: true, text: translated };
        } catch (error) {
          // 用户自己取消的，不是故障：不写 ERROR（日志里那会被当成本次运行的异常）。
          if (controller.signal.aborted) {
            logger.info('AI', `translate cancelled (${Date.now() - started}ms)`);
            return { ok: false, text: '', cancelled: true };
          }
          logger.error('AI', `translate failed: ${describeError(error)}`);
          /*
           * 跨进程不再只回一个空字符串。
           *
           * 空串没法区分「断网 / Key 过期 / 余额不足 / 模型不认」，而这四件事
           * 的下一步动作完全不同。这里带上分类 + 怎么办，但不带服务商原始响应
           * （那里面可能有用户说的话）。
           */
          return { ok: false, text: '', error: toUserError(describeAiError(error)) };
        } finally {
          untrackAiRequest(requestId, controller);
        }
      },
    ),
  );

  ipcMain.handle(
    'ai:reply',
    guarded('ai:reply', async (_event, payload) => {
      const settings = store.get();
      const requestId = payload?.requestId;
      const controller = trackAiRequest(requestId);
      try {
        const llm = getLLM();
        const started = Date.now();
        const drafts = await llm.generateReplies(
          {
            context: payload?.context ?? '',
            mode: payload?.mode ?? 'reply',
            current: payload?.current,
            chinese: payload?.chinese,
            // 等级跟着对话语言走：日语用户拿 JLPT，韩语用户拿 TOPIK。
            level: levelFor(settings.languageLevels, settings.targetLanguage),
            style: settings.replyStyle,
            length: settings.responseLength,
            profile: settings.profile,
            tone: payload?.tone ?? settings.tone,
            language: settings.targetLanguage,
            scenario: payload?.scenario ?? settings.scenarioMode,
            /*
             * 释义用哪种语言、读音提示用哪种字系 —— 这两项必须跟着设置走。
             *
             * 0.5.0 只传了 `language`（要说的语言），提示词里于是写死了
             * 「中文释义 + 汉字近音」。一个理解语言是日语的用户，看到的
             * 永远是中文，而且是一行对他毫无意义的汉字谐音。
             */
            comprehension: settings.nativeLanguage,
            hintSystem: settings.hintSystem ?? 'hanzi',
          },
          { signal: controller.signal },
        );
        const elapsed = Date.now() - started;
        recordReply(elapsed);
        logger.info(
          'AI',
          `reply generated in ${elapsed}ms (${drafts.length}, req=${payload?.requestId ?? '-'}, tone=${payload?.tone ?? settings.tone}, style=${settings.replyStyle}, level=${levelFor(settings.languageLevels, settings.targetLanguage)}, lang=${settings.targetLanguage}, comprehension=${settings.nativeLanguage}, hint=${settings.hintSystem ?? 'hanzi'}, scenario=${payload?.scenario ?? settings.scenarioMode})`,
        );
        return JSON.stringify(drafts);
      } catch (error) {
        // 被新请求替代 / 用户关掉面板：不是故障，别写 ERROR，也别弹错。
        if (controller.signal.aborted) {
          logger.info('AI', 'reply cancelled by user');
          throw error;
        }
        const info = describeAiError(error);
        // 只记错误码：info.raw 里可能是服务商回显的请求内容（= 用户说的话）。
        logger.error('AI', `reply failed: ${info.code}`);
        throw error;
      } finally {
        untrackAiRequest(requestId, controller);
      }
    }),
  );

  /*
   * 事实提取。只补规则做不了的部分：时间/金额/数量在渲染层用正则就算完了，
   * 这里负责人名、组织、事项、负责人。
   *
   * 失败一定不能影响主流程 —— 所以永远 resolve，不 throw：
   * 字幕和翻译照常走，只是这一句没有卡片。
   */
  ipcMain.handle(
    IPC.FACTS_EXTRACT,
    guarded(IPC.FACTS_EXTRACT, async (_event, payload) => {
      const requestId = payload?.requestId;
      const controller = trackAiRequest(requestId);
      const originalText = typeof payload?.originalText === 'string' ? payload.originalText : '';
      const translatedText =
        typeof payload?.translatedText === 'string' ? payload.translatedText : '';
      const itemId = typeof payload?.itemId === 'string' ? payload.itemId : '';
      if (!originalText.trim() || !itemId) return { ok: false, facts: [], message: '没有内容' };
      try {
        const drafts = await extractFactsWithModel(
          {
            originalText,
            translatedText,
            language: typeof payload?.language === 'string' ? payload.language : 'English',
          },
          { signal: controller.signal },
        );
        // 结构 / 类型 / 长度 / **出处** 全部在这一层校验完，渲染层拿到的是干净的。
        const facts = toItems(
          drafts,
          {
            itemId,
            originalText,
            translatedText,
            roundIndex: Number(payload?.roundIndex) || 0,
          },
          `f-${itemId}`,
        );
        logger.info('Facts', `extract ${facts.length} fact(s) from ${originalText.length} chars`);
        return { ok: true, facts };
      } catch (error) {
        if (controller.signal.aborted) {
          logger.info('Facts', 'extract cancelled');
          return { ok: false, facts: [], cancelled: true };
        }
        /*
         * 提取是「锦上添花」，失败不弹错误、不影响字幕。
         *
         * 只记错误类型，不记 message：JSON 解析失败的 message 里会带一段
         * **模型返回的原文**（实测是 "[mock] 你在做一..." 这种），
         * 那属于对话内容，不该进 app.log。
         */
        const kind = error instanceof Error ? error.name : typeof error;
        logger.warn('Facts', `extract failed (${kind})`);
        return { ok: false, facts: [], message: '这次没提取到重点信息' };
      } finally {
        untrackAiRequest(requestId, controller);
      }
    }),
  );

  ipcMain.handle(
    IPC.AI_CONFIRM,
    guarded(IPC.AI_CONFIRM, async (_event, payload) => {
      const requestId = payload?.requestId;
      const controller = trackAiRequest(requestId);
      try {
        const facts = Array.isArray(payload?.facts) ? payload.facts : [];
        const result = await composeConfirmation(
          {
            facts,
            language: typeof payload?.language === 'string' ? payload.language : 'English',
            comprehension: store.get().nativeLanguage,
          },
          { signal: controller.signal },
        );
        if (result.ok) logger.info('Facts', `confirm sentence for ${facts.length} fact(s)`);
        return result;
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, sentence: '', chinese: '', message: '已取消' };
        }
        const info = describeAiError(error);
        logger.warn('Facts', `confirm failed: ${info.title}`);
        return { ok: false, sentence: '', chinese: '', message: `${info.title}｜${info.hint}` };
      } finally {
        untrackAiRequest(requestId, controller);
      }
    }),
  );

  // speed 是「0.7x 慢速朗读」走的通道 —— 云端 TTS 也要能调语速。
  ipcMain.handle(
    'ai:tts',
    guarded('ai:tts', async (_event, text: string, speed?: number, requestId?: string) => {
      const controller = trackAiRequest(requestId);
      try {
        return await synthesizeSpeech(
          typeof text === 'string' ? text : '',
          speed,
          controller.signal,
        );
      } finally {
        untrackAiRequest(requestId, controller);
      }
    }),
  );

  ipcMain.handle(
    'ai:stt',
    guarded('ai:stt', async (_event, audioBase64: string, mime: string, prompt?: string) => {
      try {
        const buffer = Buffer.from(typeof audioBase64 === 'string' ? audioBase64 : '', 'base64');
        const result = await getSTT().transcribe({
          audio: new Uint8Array(buffer),
          mimeType: mime || 'audio/wav',
          // 跟随「对话语言」，否则俄/日/韩会被当成英文转写。
          language: sttLanguageCode(store.get().targetLanguage),
          prompt,
        });
        return result.text;
      } catch (error) {
        const info = describeAiError(error);
        logger.error('AI', `stt failed: ${info.code}`);
        return '';
      }
    }),
  );

  // ---- 全链路时延：给「下一步该优化哪里」提供依据 --------------------------
  // 数据只在内存、环形覆盖，界面上可以随时清空重来（换一个模型再测一轮）。
  ipcMain.handle(IPC.LATENCY_GET, guarded(IPC.LATENCY_GET, () => latencySnapshot()));
  ipcMain.handle(IPC.LATENCY_CLEAR, guarded(IPC.LATENCY_CLEAR, () => clearLatency()));
  // 主动测速：不依赖声卡，自己合成音频打给真实接口，量一次往返。
  // 成功的样本要留下来（界面上能看历次分布）—— 这个数字波动极大，单次结果不可信。
  ipcMain.handle(
    IPC.LATENCY_PROBE_STT,
    guarded(IPC.LATENCY_PROBE_STT, async () => {
      const result = await probeSttLatency();
      if (result.ok) recordProbe(result.ms);
      return result;
    }),
  );
}

// Some locked-down Windows machines (VMs, kiosk policies) cannot start
// Chromium's GPU process at all. Fall back to the software path so the
// overlay still opens instead of hard-crashing.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.disableHardwareAcceleration();

// Custom protocol: ES modules cannot be loaded from file:// (CORS, null
// origin), so production builds are served from copilot://renderer/...
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'copilot',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance owns the single-instance lock. app.quit() is async and
  // whenReady would still fire, briefly starting a full second app — exit hard.
  process.exit(0);
} else {
  app.on('second-instance', () => {
    const win = getOverlayWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    logger.info('App', `starting v${app.getVersion()} (electron ${process.versions.electron})`);

    const rendererRoot = path.join(__dirname, '../renderer');
    protocol.handle('copilot', (request) => {
      try {
        const url = new URL(request.url);
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        const full = path.join(rendererRoot, relative);
        if (!full.startsWith(rendererRoot)) {
          return new Response('forbidden', { status: 403 });
        }
        return net.fetch(pathToFileURL(full).toString());
      } catch (error) {
        logger.error('App', `protocol error: ${String(error)}`);
        return new Response('not found', { status: 404 });
      }
    });

    registerIpc();
    // createOverlayWindow() registers the audio IPC handlers.
    const win = createOverlayWindow();
    /*
     * 聊天记录：主进程统一管理的 SQLite 文件。
     *
     * 位置是 `app.getPath('userData')`（Windows 上是
     * `%APPDATA%\ai-conversation-copilot\history.db`）—— 用户数据目录，
     * 不是安装目录，所以升级 / 卸载重装（不勾删除数据）都不会清掉。
     * 打开失败不阻塞应用启动：界面会显示「记录不可用」并给出处理办法。
     */
    registerHistoryIpc(win, app.getPath('userData'));
    registerShortcuts();
    createTray(getOverlayWindow);

    // 时延数据一变就推给界面。一轮对话才产生一两条，开销可以忽略。
    onLatencyChange(() => {
      const target = getOverlayWindow();
      if (target && !target.isDestroyed()) {
        target.webContents.send(IPC.LATENCY_PUSH, latencySnapshot());
      }
    });

    // Dev helper: COPILOT_AUTOCLOSE_MS=<n> quits the app by itself after n ms.
    //
    // Verifying a long-running pipeline (multi-round listening, the silence
    // watchdog) needs the app to run for tens of seconds and then exit cleanly.
    // A detached Electron spawned from the shell leaves its renderer/GPU
    // children behind when the caller is reaped, so the app has to close
    // itself. See .dev/multi-round-repro.js.
    const autoCloseMs = Number(process.env.COPILOT_AUTOCLOSE_MS ?? 0);
    if (autoCloseMs > 0) {
      setTimeout(() => {
        logger.info('App', `auto-close after ${autoCloseMs}ms`);
        app.quit();
      }, autoCloseMs);
    }

    // Auto-start listening only after the privacy notice has been accepted.
    const settings = getSettingsStore().get();
    if (settings.privacyAccepted) {
      startAudioPipeline(win);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow();
    });

    /*
     * Dev helper: COPILOT_FACTS_PROBE=1 —— 只测「事实卡展开后主按钮还在不在」。
     *
     * 完整自检要跑两分多钟，但布局问题必须靠**量出来的矩形**判断，不能靠猜。
     * 这个探针只做必要的几步（注入一句带事实的话 → 展开面板 → 量各区块高度），
     * 十几秒就能给出结论。
     */
    if (process.env.COPILOT_FACTS_PROBE) {
      setTimeout(async () => {
        try {
          const result = await win.webContents.executeJavaScript(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const chip = (label) =>
                [...document.querySelectorAll('button')].find(
                  (b) => b.textContent.trim() === label,
                );
              await window.copilot.setSettings({ facts: { enabled: true, useModel: false } });
              await window.copilot.audioDemoLine(
                'Tomorrow at 3 pm we will have a meeting in the conference room, and remember to bring the 3 copies of the materials.',
              );
              await sleep(3200);
              const rect = (selector) => {
                const node = document.querySelector(selector);
                if (!node) return null;
                const r = node.getBoundingClientRect();
                return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
              };
              const probe = () => ({
                vh: window.innerHeight,
                primary: rect('[data-primary-action]'),
                quick: rect('[data-quick-actions]'),
                fact: rect('[data-fact-panel]'),
                factBody: rect('#fact-panel-body'),
                reply: rect('[data-reply-panel]'),
                subtitle: rect('[data-subtitle-list]'),
                meter: rect('[data-audio-meter]'),
                banner: rect('[data-demo-banner]'),
              });
              const collapsed = probe();
              document.querySelector('[data-fact-toggle]')?.click();
              await sleep(400);
              const expanded = probe();
              // 同一件事只能有一行：把每行前 40 字打出来看有没有重复。
              const rows = [...document.querySelectorAll('[data-fact-row]')].map((n) =>
                (n.textContent ?? '').replace(/定位修改确认删除取消确认/g, '').trim().slice(0, 40),
              );
              expanded.rows = rows;
              document.querySelector('[data-fact-toggle]')?.click();
              await sleep(300);
              // 先量「只开回复面板」—— 这是不是本来就挤，得先分清。
              document.querySelector('[data-primary-action]')?.click();
              let waited = 0;
              while (waited < 25000 && !document.querySelector('[data-reply-panel]')) {
                await sleep(500);
                waited += 500;
              }
              const replyOnly = probe();
              // 再量「回复面板 + 事实卡展开」—— 这才是最挤的叠加。
              document.querySelector('[data-fact-toggle]')?.click();
              await sleep(400);
              const replyAndFacts = probe();
              document.querySelector('[data-fact-toggle]')?.click();
              await sleep(200);
              return JSON.stringify({ collapsed, expanded, replyOnly, replyAndFacts });
            })()`,
          );
          logger.info('App', `FACTS PROBE: ${result}`);
        } catch (error) {
          logger.error('App', `facts probe failed: ${String(error)}`);
        }
        setTimeout(() => app.quit(), 400);
      }, 3500);
    }

    /*
     * 0.5.0 真界面自检：COPILOT_V050=<输出目录>。
     *
     * 跑完会写 report.json + 若干截图，并还原设置后退出。
     * 与 COPILOT_SCREENSHOT 分开，避免两个自检互相抢窗口状态。
     */
    if (process.env.COPILOT_V050) {
      setTimeout(() => void runV050SelfCheck(win), 2200);
    }

    /*
     * 0.6.0 真界面自检：COPILOT_V060=<输出目录>。
     *
     * 验的是这一版新增的三件交互（点词看读音 / 双面卡 / 语言方向与语音状态）
     * 以及「第 51 条往前的记录还能翻出来」。跑完写 v060-selfcheck.json + 截图，
     * 还原设置后由调用方退出。
     */
    if (process.env.COPILOT_V060) {
      setTimeout(() => void runV060SelfCheck(win), 2200);
    }

    /*
     * 「整个程序退掉再启动」的跨进程检查：COPILOT_V061=write|read + COPILOT_V061_DIR。
     * 两次进程用同一个 --user-data-dir，第二次读回第一次写的内容。
     */
    if (process.env.COPILOT_V061) {
      setTimeout(() => void runV061RestartCheck(), 1500);
    }

    /*
     * 0.6.3 采集状态与中文草稿检查：COPILOT_V063_CHECK=<输出目录>。
     * 验证「启动不自动采集」「开始/停止采集状态一致」「中文草稿保留到成功」。
     */
    if (process.env.COPILOT_V063_CHECK) {
      setTimeout(() => void runV063CaptureCheck(), 2200);
    }

    // Dev helper: COPILOT_SCREENSHOT=<path> captures the overlay and exits.
    if (process.env.COPILOT_SHOT) {
      setTimeout(async () => {
        try {
          // 先接受隐私说明（若存在），进入主界面再截图。
          await win.webContents.executeJavaScript(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const accept = document.querySelector('[data-privacy-accept]');
              if (accept) { accept.click(); await sleep(700); }
            })()`,
          );
          const image = await win.webContents.capturePage();
          fs.writeFileSync(process.env.COPILOT_SHOT as string, image.toPNG());
          logger.info('App', `shot saved to ${process.env.COPILOT_SHOT}`);
        } catch (error) {
          logger.warn('App', `shot failed: ${String(error)}`);
        }
        setTimeout(() => app.quit(), 200);
      }, 3000);
    }

    // Dev helper: COPILOT_SCREENSHOT=<path> captures the overlay and exits.
    if (process.env.COPILOT_SCREENSHOT) {
      setTimeout(async () => {
        try {
          const text = await win.webContents.executeJavaScript(
            'document.body.innerText.slice(0, 600)',
          );
          // 只记长度，不记内容：这条自检会把整块字幕区（= 对话正文）打印出来，
          // 而 app.log 是正式日志。要肉眼看 DOM 时用 logger.debug（只在 dev 打控制台）。
          logger.debug('App', `DOM text length=${text.length}`);

          // ---- self-check of the interaction features --------------------
          const check = await win.webContents.executeJavaScript(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const body = () => document.body.innerText;
              const btn = (label) =>
                [...document.querySelectorAll('button')].find((b) => b.textContent.includes(label));
              // 真实模型慢的时候 2 秒根本回不来，等固定时长会把「还没到」误判成
              // 「生成失败」，所以这里改成轮询。
              const waitForCards = async (limit) => {
                let waited = 0;
                while (waited < limit && !document.querySelector('[data-reply-card]')) {
                  await sleep(500);
                  waited += 500;
                }
                return document.querySelectorAll('[data-reply-card]').length;
              };
              const out = {};
              // 开局探针：设置面板本不该是打开状态。
              out.showSettingsAtStart = !!document.querySelector('[data-settings-tabs]');
              // 归一化：残留打开就先关掉，保证后面每一步都是确定状态
              // （设置面板盖在界面上会让按文字找按钮的断言全乱套）。
              if (out.showSettingsAtStart) {
                [...document.querySelectorAll('button')]
                  .find((b) => b.textContent.trim() === '返回')
                  ?.click();
                await sleep(700);
              }
              out.settingsNormalizedClosed = !document.querySelector('[data-settings-tabs]');
              const demoBtn = () =>
                [...document.querySelectorAll('button')].find(
                  (b) => b.textContent.trim() === '说一句示例',
                );
              // Normalise first: the scenario mode is persisted, so a previous
              // run could have left the app in video mode and every
              // conversation-mode assertion below would silently fail.
              [...document.querySelectorAll('button')]
                .find((b) => b.textContent.trim() === '对话')
                ?.click();
              await sleep(400);

              // Sample chat is off by default, so fill the transcript before
              // measuring — otherwise "scrollable" is trivially empty.
              for (let index = 0; index < 8; index += 1) {
                demoBtn()?.click();
                await sleep(420);
              }

              const scroller = [...document.querySelectorAll('div')].find(
                (d) => typeof d.className === 'string' && d.className.includes('subtle-scroll'),
              );
              out.bubbles = document.querySelectorAll('.animate-fade-in-up').length;
              out.scrollable = scroller ? scroller.scrollHeight > scroller.clientHeight + 4 : null;
              // 用户反馈「无法显示中文谐音」：字幕区现在也带谐音行，直接数一下。
              out.subtitlePron = document.querySelectorAll('[data-subtitle-pron]').length;
              out.subtitlePronText = (
                document.querySelector('[data-subtitle-pron]')?.textContent ?? ''
              ).slice(0, 40);
              out.subtitlePronHasChinese =
                (out.subtitlePronText.match(/[\\u4e00-\\u9fff]/g) ?? []).length >= 2;
              out.toneBar = body().includes('语气');
              out.toneChips = [...document.querySelectorAll('button')]
                .filter((b) => ['开心','难过','失望','期待','生气','感谢','调侃','担心','吐槽'].includes(b.textContent.trim()))
                .map((b) => b.textContent.trim());

              btn('帮我回复')?.click();
              out.replyCards = await waitForCards(20000);
              out.panelHeader = body().includes('AI 帮回复');
              out.closeShown = !!btn('关闭');
              out.htmlHasPanel = document.body.innerHTML.includes('AI 帮回复');
              out.slowBtn = [...document.querySelectorAll('button')].some(
                (b) => b.textContent.trim() === '0.7x',
              );
              out.pronBlock = document.querySelectorAll('[data-pron-block]').length;
              out.pronText = (document.querySelector('[data-pron-block]')?.textContent ?? '').slice(0, 60);
              // 中文谐音必须真的有汉字（以前模型经常留空 / 直接抄中文翻译）。
              out.pronHasChinese = (out.pronText.match(/[\\u4e00-\\u9fff]/g) ?? []).length >= 2;
              // 卡片上的「中文谐音」那一行必须是干净的中文。
              // 实测模型会把**中文句子自己的注音**塞进来（太 ɡe 棒 了 我 ɑm 也 是），
              // 或者干脆给纯拼音（tài bāng le wǒ yě shì）—— 那正是用户说的
              // 「乱七八糟」，必须由本地引擎拦掉。
              // 注意：整段自检是在模板字符串里拼出来的，注释里也不能出现反引号。
              out.pronChineseSample = (
                document.querySelector('[data-pron-chinese]')?.textContent ?? ''
              ).trim();
              out.pronChineseNoLatin = !/[A-Za-z]{2,}/.test(out.pronChineseSample);
              out.pronChineseNoIpa = !/[əɪʊæɑɔʌʃʒθðŋɡˈˌː]/.test(out.pronChineseSample);
              // 音标那一行要么空着，要么是英文音标 —— 绝不能是中文拼音。
              out.pronIpaSample = (
                document.querySelector('[data-pron-ipa]')?.textContent ?? ''
              ).trim();
              out.pronIpaNoHanzi = !/[\\u4e00-\\u9fff]/.test(out.pronIpaSample);
              // 回复面板里的风格快捷切换：卡片上方应该有一排风格按钮。
              out.styleSwitchShown = !!document.querySelector('[data-style-switch]');
              out.styleChips = [...document.querySelectorAll('[data-style-chip]')].map((node) =>
                node.getAttribute('data-style-chip'),
              );
              document.querySelector('[data-style-chip="funny"]')?.click();
              await sleep(800);
              out.styleAfterChip = (await window.copilot.getSettings()).replyStyle;
              // 点完风格必须真的重出一版（旧回复会先清空，所以要等新卡片回来）。
              let styleWaited = 0;
              while (styleWaited < 25000 && !document.querySelector('[data-reply-card]')) {
                await sleep(500);
                styleWaited += 500;
              }
              out.styleChipCards = document.querySelectorAll('[data-reply-card]').length;
              document.querySelector('[data-style-chip="natural"]')?.click();
              await sleep(800);
              out.styleResetChip = (await window.copilot.getSettings()).replyStyle;

              // 风格行必须「看得见」：面板滚到底时它不能被吸顶标题盖住。
              // （截图里真的出现过整排风格被滚没了的情况。）
              const panelEl = document.querySelector('[data-reply-panel]');
              if (panelEl) {
                panelEl.scrollTop = panelEl.scrollHeight;
                await sleep(250);
              }
              const swEl = document.querySelector('[data-style-switch]');
              if (panelEl && swEl) {
                const pRect = panelEl.getBoundingClientRect();
                const sRect = swEl.getBoundingClientRect();
                out.styleRowVisible =
                  sRect.height > 8 && sRect.top >= pRect.top - 1 && sRect.bottom <= pRect.bottom + 1;
              } else {
                out.styleRowVisible = false;
              }

              const rant = [...document.querySelectorAll('button')].find(
                (b) => b.textContent.trim() === '吐槽',
              );
              if (rant) {
                rant.click();
                await sleep(150);
                btn('帮我回复')?.click();
                await waitForCards(20000);
              }
              out.rantReplies = body().slice(0, 900);

              // Dismiss the panel via its own header button (the title-bar ×
              // also matches "关闭" and would close the whole window).
              [...document.querySelectorAll('button')]
                .find((b) => b.textContent.trim() === '关闭')
                ?.click();
              await sleep(700);
              out.afterCloseHeader = body().includes('AI 帮回复');
              out.afterCloseCards = document.querySelectorAll('[data-reply-card]').length;

              // ---- sample-chat switch + conversation records -------------
              out.demoSwitch = body().includes('自动播放示例对话');
              const startsWith = (label) =>
                [...document.querySelectorAll('button')].find((b) =>
                  b.textContent.trim().startsWith(label),
                );
              const bubbles = () => document.querySelectorAll('.animate-fade-in-up').length;
              const before = bubbles();
              startsWith('说一句示例')?.click();
              await sleep(900);
              out.demoLineAdded = bubbles() > before;

              startsWith('记录')?.click();
              await sleep(400);
              out.recordsPanel = body().includes('对话记录');
              const newRecord = [...document.querySelectorAll('button')].find((b) =>
                b.textContent.includes('＋ 新增对话记录'),
              );
              out.newRecordBtn = !!newRecord;
              newRecord?.click();
              await sleep(600);
              out.bubblesAfterNewRecord = bubbles();
              out.backFromRecords = !body().includes('＋ 新增对话记录');

              // ---- scenario modes: video / exam ---------------------------
              const chip = (label) =>
                [...document.querySelectorAll('button')].find(
                  (b) => b.textContent.trim() === label,
                );
              out.scenarioChips = ['对话', '看视频', '四六级'].filter((label) => !!chip(label));

              /*
               * ---- 0.4.0：首页音源条 / 离线沟通卡 / 字号入口 -------------
               * 这一批改动的共同点是「用户第一眼要能确认」：在听什么、有没有
               * 在听、读不清时怎么放大。断言全部落在 data-* 属性上，不靠截图
               * 人眼看 —— 截图只能证明「某一次像是对的」。
               */
              out.sourceBar = !!document.querySelector('[data-source-bar]');
              out.sourceLabel = (
                document.querySelector('[data-source-label]')?.textContent ?? ''
              ).trim().slice(0, 60);
              out.audioPhase =
                document.querySelector('[data-audio-status]')?.getAttribute('data-phase') ?? '';
              out.audioPhaseValid = [
                'stopped',
                'starting',
                'live',
                'silent',
                'paused',
                'failed',
              ].includes(out.audioPhase);
              out.audioDetail = (
                document.querySelector('[data-audio-detail]')?.textContent ?? ''
              ).trim().slice(0, 60);
              out.commCards = document.querySelectorAll('[data-comm-card]').length;
              out.fontIncBtn = !!document.querySelector('[data-font-inc]');
              out.fontDecBtn = !!document.querySelector('[data-font-dec]');
              out.contrastToggle = !!document.querySelector('[data-contrast-toggle]');
              out.moreToggle = !!document.querySelector('[data-more-toggle]');
              // 高级区默认收起：语气、场景、中文输入框不该占着首页。
              out.moreCollapsed = document.querySelector('[data-more-panel]')?.hasAttribute('hidden');

              // 沟通卡：点开 → 出现大字英文 → 关闭 → 回到字幕（焦点还给原按钮）。
              document.querySelector('[data-comm-card]')?.click();
              await sleep(350);
              const commTextNode = document.querySelector('[data-comm-text]');
              out.commOverlay = !!document.querySelector('[data-comm-overlay]');
              out.commText = (commTextNode?.textContent ?? '').trim().slice(0, 60);
              out.commTextPx = commTextNode
                ? parseFloat(getComputedStyle(commTextNode).fontSize) || 0
                : 0;
              out.commFocusOnClose =
                document.activeElement?.getAttribute('data-comm-close') !== null &&
                document.activeElement?.hasAttribute('data-comm-close');
              document.querySelector('[data-comm-close]')?.click();
              await sleep(300);
              out.commClosed = !document.querySelector('[data-comm-overlay]');

              chip('看视频')?.click();
              await sleep(600);
              out.liveBar = !!document.querySelector('[data-live-translate]');
              // Push a few demo lines so at least one foreign line + a
              // finished translation are guaranteed to be on screen.
              for (let index = 0; index < 3; index += 1) {
                chip('说一句示例')?.click();
                await sleep(900);
              }
              out.liveOriginal = (
                document.querySelector('[data-live-original]')?.textContent ?? ''
              ).slice(0, 50);
              out.liveTranslated = (
                document.querySelector('[data-live-translated]')?.textContent ?? ''
              ).slice(0, 50);
              // 有内容进来之后，顶部状态条不能还挂着「暂未收到声音」。
              out.audioPhaseAfterLine =
                document.querySelector('[data-audio-status]')?.getAttribute('data-phase') ?? '';

              /*
               * ---- 0.4.0：译文字号真的生效，放大后不裁切 ----------------
               * 用 setSettings 精确设到 32px，量 getComputedStyle 的真实像素，
               * 再确认底栏切进了「大字模式」。顺手断言没有横向溢出 —— 40px 时
               * 一个长单词就能把 460px 的窗口撑出滚动条。
               */
              out.smallFontPx = (() => {
                const node = document.querySelector('[data-translation-state="ok"]');
                return node ? Math.round(parseFloat(getComputedStyle(node).fontSize) || 0) : 0;
              })();
              const fontPx = () => {
                const node = document.querySelector('[data-translation-state="ok"]');
                return node ? Math.round(parseFloat(getComputedStyle(node).fontSize) || 0) : 0;
              };
              const inc = () => document.querySelector('[data-font-inc]')?.click();
              const dec = () => document.querySelector('[data-font-dec]')?.click();

              /*
               * 点真实的 A+ 按钮放大，而不是 setSettings 直改。
               *
               * 直改只写主进程的存储，渲染层的 zustand 收不到通知，界面根本
               * 不会变 —— 这样测出来的「字号没变」是测试假象，不是产品缺陷。
               * 点按钮走的是用户真实路径。
               */
              for (let step = 0; step < 4; step += 1) {
                inc();
                await sleep(220);
              }
              out.bigFontPx = fontPx();
              out.bigFontCompactChrome = !!document.querySelector('[data-compact-chrome]');
              out.noHorizontalOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
              // 顶到 40px 上限：底部那一行按钮不能掉出视口。
              for (let step = 0; step < 20; step += 1) {
                inc();
                await sleep(180);
              }
              out.maxFontPx = fontPx();
              out.maxFontIncDisabled =
                document.querySelector('[data-font-inc]')?.hasAttribute('disabled') ?? null;
              const bottomRow =
                document.querySelector('[data-primary-action]') ??
                document.querySelector('[data-comm-cards]');
              out.maxFontPrimaryVisible = bottomRow
                ? bottomRow.getBoundingClientRect().bottom <= window.innerHeight + 1
                : null;
              /*
               * 还原到调用前的字号。
               *
               * 步长是 2px，23 这种奇数从 40 减不下来 —— 所以先退到底（A− 变灰），
               * 再一路 A+ 上去找原值。找不到也不硬凑，如实记下差多少。
               */
              const original = out.smallFontPx;
              for (let step = 0; step < 20; step += 1) {
                if (document.querySelector('[data-font-dec]')?.hasAttribute('disabled')) break;
                dec();
                await sleep(90);
              }
              for (let step = 0; step < 20; step += 1) {
                if (fontPx() >= original) break;
                if (document.querySelector('[data-font-inc]')?.hasAttribute('disabled')) break;
                inc();
                await sleep(90);
              }
              out.fontRestored = fontPx();
              out.fontRestoreExact = fontPx() === original;
              const primary = () => document.querySelector('[data-primary-action]');
              out.primaryAction = primary()?.getAttribute('data-primary-action') ?? '';
              // The headline behaviour: nobody clicks anything — the silence
              // watchdog must notice the pause and draft the reply by itself.
              await sleep(3800);
              out.autoPauseReplies = document.querySelectorAll('[data-reply-card]').length;
              out.autoPauseBadge = (
                document.querySelector('[data-live-translate]')?.textContent ?? ''
              ).includes('已暂停');
              out.primaryAfterAutoPause = primary()?.getAttribute('data-primary-action') ?? '';
              out.pausePanelTitle = (
                document.querySelector('[data-panel-title]')?.textContent ?? ''
              ).trim();
              out.videoKindLabels = [...document.querySelectorAll('[data-reply-card] .chip')].map(
                (node) => node.textContent.trim(),
              );
              out.liveRound =
                document.querySelector('[data-live-round]')?.textContent?.trim() ?? '';
              out.replyRoundBadge =
                document.querySelector('[data-reply-round]')?.textContent?.trim() ?? '';

              // ---- 多轮对话：新一轮开始时旧回复必须被标记为过时 -----------
              // 这是用户报的「第一轮暂停后，第二轮像没被监听」的核心：新一轮
              // 已经来了，面板上还挂着上一轮的卡，界面却一声不吭。
              // 临时关掉自动回复，免得看门狗在这几百毫秒里又刷出一版新回复，
              // 把要断言的「过时」状态冲掉。
              await window.copilot.setSettings({ autoReplyOnPause: false });
              chip('说一句示例')?.click();
              await sleep(900);
              out.staleShown = !!document.querySelector('[data-reply-stale]');
              out.staleText = (
                document.querySelector('[data-reply-stale]')?.textContent ?? ''
              ).slice(0, 60);
              document.querySelector('[data-reply-stale-refresh]')?.click();
              await sleep(2500);
              out.staleClearedAfterRefresh = !document.querySelector('[data-reply-stale]');
              out.replyRoundAfterRefresh =
                document.querySelector('[data-reply-round]')?.textContent?.trim() ?? '';
              await window.copilot.setSettings({ autoReplyOnPause: true });

              primary()?.click();
              await sleep(400);
              out.primaryAfterResume = primary()?.getAttribute('data-primary-action') ?? '';

              // Exam mode keeps the manual pause button as the entry point.
              chip('四六级')?.click();
              await sleep(600);
              out.examPrimaryLabel = primary()?.textContent?.trim() ?? '';
              primary()?.click();
              await sleep(2800);
              out.examPanelTitle = (
                document.querySelector('[data-panel-title]')?.textContent ?? ''
              ).trim();
              out.examKindLabels = [...document.querySelectorAll('[data-reply-card] .chip')].map(
                (node) => node.textContent.trim(),
              );
              out.examFirstReply = (
                document.querySelector('[data-reply-card] p')?.textContent ?? ''
              ).slice(0, 80);

              // Leave the app exactly as we found it.
              chip('对话')?.click();
              await sleep(400);
              out.backToConversation = !document.querySelector('[data-live-translate]');
              chip('自动')?.click();
              await sleep(300);

              // ---- audio capture assertions ------------------------------
              // Play real English speech through the OS default output device,
              // so the WASAPI loopback has something genuine to capture —
              // exactly the situation "a movie is playing" reproduces.
              const speechLines = [
                'Hey, do you want to grab dinner after the movie?',
                'I was thinking about that new Italian place downtown.',
                'Their pasta is really good, and it is not expensive.',
              ];
              let spokenCount = 0;
              const speakNext = () => {
                try {
                  const utter = new SpeechSynthesisUtterance(
                    speechLines[spokenCount % speechLines.length],
                  );
                  utter.lang = 'en-US';
                  utter.volume = 1;
                  utter.rate = 0.95;
                  window.speechSynthesis.speak(utter);
                  spokenCount += 1;
                } catch (error) {
                  out.speakError = String(error);
                }
              };
              speakNext();
              const speaker = setInterval(speakNext, 1200);
              await sleep(900);

              /*
               * 两次间隔几秒的读数，证明电平是活的、不是卡在 0。
               *
               * 0.4.0 把独立的 20 格电平条并进了顶部音源条（高度从 30px 降到 2px），
               * 但 data-audio-db / data-audio-live 这两个读数留着，断言不变。
               */
              const meter = () => document.querySelector('[data-source-bar]');
              out.meterPresent = !!meter();
              out.meterSource = (
                document.querySelector('[data-source-label]')?.textContent ?? ''
              )
                .trim()
                .slice(0, 24);
              out.meterDb1 = meter()?.getAttribute('data-audio-db') ?? 'none';
              await sleep(2600);
              out.meterDb2 = meter()?.getAttribute('data-audio-db') ?? 'none';
              out.meterLive = meter()?.getAttribute('data-audio-live') ?? 'none';
              out.spokenCount = spokenCount;
              clearInterval(speaker);
              try {
                window.speechSynthesis.cancel();
              } catch {
                /* ignore */
              }

              out.demoBanner = !!document.querySelector('[data-demo-banner]');
              out.diagnosticsShown = !!document.querySelector('[data-audio-diagnostics]');
              out.diagnosticsText = (
                document.querySelector('[data-audio-diagnostics]')?.textContent ?? ''
              ).slice(0, 110);

              // ---- 诊断结果透明化（一）：没点按钮就不该出现任何结果 -------
              // 真正的体检在设置页那一段点（那里按钮一定存在 —— 空态面板有时会
              // 走到「已经听到声音了」的分支，那边没有诊断按钮）。
              out.healthBeforeClick = !!document.querySelector('[data-health-report]');

              // 刚才用系统语音真实说了几句英语，回环采集 + 识别应该已经把字幕
              // 堆出来了 —— 这时才能验证「字幕区也有中文谐音」。
              await sleep(4000);
              out.subtitleAfterSpeech = document.querySelectorAll('[data-subtitle-item]').length;
              out.subtitlePronAfterSpeech = document.querySelectorAll(
                '[data-subtitle-pron]',
              ).length;
              out.subtitlePronSample = (
                document.querySelector('[data-subtitle-pron]')?.textContent ?? ''
              ).slice(0, 40);
              // 第一条「外语」字幕的中文翻译（限定在字幕项内，别把回复卡片的
              // 译文数进来）。第一项可能是「你说的话」，那就没有译文那一行 ——
              // 所以要挑一条结构完整的，直接取 p[1] 会随机取空。
              out.subtitleTranslatedSample = (() => {
                const nodes = [...document.querySelectorAll('[data-subtitle-item]')];
                for (const node of nodes) {
                  const ps = node.querySelectorAll('p');
                  if (ps.length >= 3) return (ps[1].textContent ?? '').slice(0, 50);
                }
                return '';
              })();
              // 多轮：轮次必须真的显示出来（用户说「无法开启第二轮监听」，
              // 看不见轮次就分不清「没在听」和「在听但没说话」）。
              out.subtitleRound =
                document.querySelector('[data-subtitle-round]')?.textContent?.trim() ?? '';

              // ---- 关键事实确认卡 -----------------------------------------
              // 演示语料里一个时间/金额都没有，规则一条都提不出来 —— 所以这里
              // 塞一句真实的会议通知，让「字幕定稿 → 规则提取 → 事实卡」整条
              // 链路真跑一遍。关掉 useModel：自检环境不该依赖付费模型。
              await window.copilot.setSettings({ facts: { enabled: true, useModel: false } });
              await window.copilot.audioDemoLine(
                'Tomorrow at 3 pm we will have a meeting in the conference room, and remember to bring the 3 copies of the materials.',
              );
              await sleep(3200);
              const factToggle = () => document.querySelector('[data-fact-toggle]');
              const factRows = () => document.querySelectorAll('[data-fact-row]');
              out.factToggle = !!factToggle();
              // 默认折叠：不展开就不该有任何事实行（不抢字幕的位置）。
              out.factExpandedDefault = factToggle()?.getAttribute('aria-expanded') ?? 'missing';
              out.factRowsWhileCollapsed = factRows().length;
              factToggle()?.click();
              await sleep(350);
              out.factRows = factRows().length;
              out.factRowText = (document.querySelector('[data-fact-row]')?.textContent ?? '')
                .slice(0, 90);
              // 面板自己滚动、高度封顶，不能把底部主按钮顶出屏幕。
              out.factBodyAutoScroll = Boolean(
                document.getElementById('fact-panel-body')?.querySelector('.overflow-y-auto'),
              );
              /*
               * 事实卡展开后，「底部那一行还能不能按到」。
               *
               * 0.4.0 起实时对话场景不再有整行的主按钮（核心动作是读字幕，
               * 不是让 AI 说话），所以这里断言的落点换成常显的沟通卡那一行；
               * 看视频 / 听力仍有主按钮，在那种场景下改测主按钮。
               */
              out.factPrimaryVisible = (() => {
                const el =
                  document.querySelector('[data-primary-action]') ??
                  document.querySelector('[data-comm-cards]');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return r.top >= 0 && r.bottom <= window.innerHeight + 1;
              })();
              // 事实卡展开时字幕区至少还要剩下两行（23px × 1.45 ≈ 34px/行）。
              out.subtitleAreaWhileFactsOpen = (() => {
                const el = document.querySelector('[data-subtitle-list]');
                return el ? Math.round(el.getBoundingClientRect().height) : null;
              })();
              // 键盘：标题和「帮我确认」都要能聚焦，不能是 outline:none。
              factToggle()?.focus();
              out.factToggleFocused = document.activeElement === factToggle();
              // 点一条事实 → 跳回它来源的那句字幕并高亮。
              document
                .querySelector('[data-fact-row] button[title="跳到这句话所在的位置"]')
                ?.click();
              await sleep(800);
              out.factHighlighted = document.querySelectorAll('[data-highlight="on"]').length;
              // 勾选一条 → 按钮文案带计数。
              document.querySelector('[data-fact-row] input[type="checkbox"]')?.click();
              await sleep(250);
              out.factConfirmLabel = (
                document.querySelector('[data-fact-confirm]')?.textContent ?? ''
              ).trim();
              // 取消选择后不能残留草稿 / 选中态。
              [...document.querySelectorAll('button')]
                .find((b) => b.textContent.trim() === '取消选择')
                ?.click();
              await sleep(250);
              out.factAfterClearLabel = (
                document.querySelector('[data-fact-confirm]')?.textContent ?? ''
              ).trim();
              out.factDraftAfterClear = document.querySelectorAll('[data-fact-draft]').length;
              // 再折起来，行必须真的消失。
              factToggle()?.click();
              await sleep(250);
              out.factCollapsedAgain = factRows().length === 0;
              // 新建会话必须**同步清掉事实**：只清字幕会让上一场的「明天下午
              // 三点」挂到新的空白会话上，用户会以为它记错了。
              factToggle()?.click();
              await sleep(250);
              out.factRowsBeforeNewSession = factRows().length;
              [...document.querySelectorAll('button')]
                .find((b) => b.textContent.trim().startsWith('记录'))
                ?.click();
              await sleep(500);
              [...document.querySelectorAll('button')]
                .find((b) => b.textContent.includes('＋ 新增对话记录'))
                ?.click();
              await sleep(800);
              out.factsAfterNewSession = document.querySelectorAll('[data-fact-toggle]').length;
              out.factVisibleAfterNewSession = document.querySelectorAll('[data-fact-row]').length;
              out.subtitlesAfterNewSession =
                document.querySelectorAll('[data-subtitle-item]').length;
              await window.copilot.setSettings({ facts: { enabled: true, useModel: true } });

              // ---- 设置页：常用功能 / API 功能 两个标签 -------------------
              // 标题栏那颗按钮是「切换」语义，先判断当前是否已开，避免误关。
              if (!document.querySelector('[data-settings-tabs]')) {
                [...document.querySelectorAll('button')]
                  .find((b) => b.getAttribute('aria-label') === '打开设置')
                  ?.click();
              }
              await sleep(900);
              out.settingsTabs = [...document.querySelectorAll('[data-settings-tab]')].map((n) =>
                n.getAttribute('data-settings-tab'),
              );
              out.tabLabels = [...document.querySelectorAll('[data-settings-tabs] button')].map(
                (n) => (n.textContent ?? '').trim().slice(0, 4),
              );
              out.generalActive =
                document
                  .querySelector('[data-settings-tab="general"]')
                  ?.getAttribute('data-active') === 'true';
              out.generalAudio = body().includes('音频（听谁的）');
              out.generalProbe = body().includes('一键诊断');
              // 语气 / 风格：文案必须说清「必须按设置来」「自动时看对方说啥」。
              out.toneHint = (
                document.querySelector('[data-tone-hint]')?.textContent ?? ''
              )
                .trim()
                .slice(0, 150);
              out.toneHintMentionsAuto = out.toneHint.includes('自动');
              out.toneHintMentionsMust = out.toneHint.includes('必须');

              // ---- 诊断结果透明化（二）：点了才出报告，且只列有问题的项 ----
              const healthBtn = () => document.querySelector('[data-health-run-settings]');
              out.healthRunBtn = !!healthBtn();
              // 点之前设置页里也不能有任何报告（第一张截图那张卡片就是反例）。
              out.healthReportBeforeClick = !!document.querySelector('[data-health-report]');
              if (healthBtn()) {
                healthBtn().click();
                let waitedHealth = 0;
                while (waitedHealth < 45000 && !document.querySelector('[data-health-report]')) {
                  await sleep(500);
                  waitedHealth += 500;
                }
                out.healthWaited = waitedHealth;
                out.healthShown = !!document.querySelector('[data-health-report]');
                out.healthText = (
                  document.querySelector('[data-health-report]')?.textContent ?? ''
                )
                  .trim()
                  .slice(0, 180);
                out.healthItems = document.querySelectorAll('[data-health-item]').length;
                out.healthLevels = [...document.querySelectorAll('[data-health-item]')].map((n) =>
                  n.getAttribute('data-health-level'),
                );
                out.healthOkOnly =
                  !!document.querySelector('[data-health-ok]') && out.healthItems === 0;
              }

              // ---- 用户反馈：回复风格点不动、只能停在 natural --------------
              // 走一遍真实点击路径（打开下拉 → 点选项 → 读回），而不是直接改 value。
              const openMenu = async (triggerAttr) => {
                document.querySelector(triggerAttr)?.click();
                await sleep(450);
                // 偶发：上一次的弹层还没收干净，第一次点击被吃掉 → 再点一次。
                if (!document.querySelector('[data-select-menu]')) {
                  document.querySelector(triggerAttr)?.click();
                  await sleep(450);
                }
                return !!document.querySelector('[data-select-menu]');
              };
              const pick = async (triggerAttr, optionValue) => {
                await openMenu(triggerAttr);
                document
                  .querySelector('[data-select-option="' + optionValue + '"]')
                  ?.click();
                await sleep(800);
                return document.querySelector(triggerAttr)?.getAttribute('data-value') ?? 'none';
              };
              out.nativeSelect =
                document.querySelector('[data-native-select]')?.getAttribute('data-value') ?? 'none';
              out.styleBefore =
                document.querySelector('[data-reply-style]')?.getAttribute('data-value') ?? 'none';
              out.styleMenuOpen = await openMenu('[data-reply-style]');
              out.styleOptionCount = document.querySelectorAll('[data-select-option]').length;
              document.querySelector('[data-select-option="funny"]')?.click();
              await sleep(850);
              out.styleMenuClosed = !document.querySelector('[data-select-menu]');
              out.styleAfter =
                document.querySelector('[data-reply-style]')?.getAttribute('data-value') ?? 'none';
              out.stylePersisted = (await window.copilot.getSettings()).replyStyle;
              // 「回复长度」同一个组件，顺手一起验。
              out.lengthAfter = await pick('[data-length-select]', 'short');
              // 复位成默认值，别污染用户设置。
              await pick('[data-reply-style]', 'natural');
              await pick('[data-length-select]', 'normal');
              const settled = await window.copilot.getSettings();
              out.styleReset = settled.replyStyle;
              out.lengthReset = settled.responseLength;

              // ---- 语言水平：从 CEFR（像驾照的 A1/C1）换成国内英语等级 ----
              out.gradeBefore =
                document.querySelector('[data-grade-select]')?.getAttribute('data-value') ?? 'none';
              out.gradeMenuOpen = await openMenu('[data-grade-select]');
              out.gradeLabels = [...document.querySelectorAll('[data-select-option]')].map((n) =>
                (n.textContent ?? '').trim().slice(0, 14),
              );
              out.gradeOptionCount = out.gradeLabels.length;
              out.gradeLooksChinese =
                out.gradeLabels.some((t) => t.includes('六级')) &&
                out.gradeLabels.some((t) => t.includes('B 级'));
              out.gradeHasCefr = out.gradeLabels.some((t) => /^[ABC][12]\b/.test(t));
              document.querySelector('[data-select-option="cet6"]')?.click();
              await sleep(900);
              out.gradeAfter =
                document.querySelector('[data-grade-select]')?.getAttribute('data-value') ?? 'none';
              out.gradePersisted = (await window.copilot.getSettings()).englishLevel;
              await pick('[data-grade-select]', 'cet4');
              out.gradeReset = (await window.copilot.getSettings()).englishLevel;

              // ---- 语言水平：每种对话语言一套刻度 --------------------------
              // 英语是 B 级～专八，日语是 JLPT N5～N1，韩语是 TOPIK 1～6 级。
              // 换对话语言时等级下拉必须跟着换，而且各记各的（切回英语还是四级）。
              const closeMenu = async () => {
                document.dispatchEvent(
                  new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
                );
                await sleep(250);
              };
              const levelLabels = async () => {
                await openMenu('[data-grade-select]');
                const labels = [...document.querySelectorAll('[data-select-option]')].map((n) =>
                  (n.textContent ?? '').trim().slice(0, 18),
                );
                await closeMenu();
                return labels;
              };
              out.targetSelectExists = !!document.querySelector('[data-target-select]');
              out.levelEnglish = await levelLabels();
              await pick('[data-target-select]', 'Japanese');
              await sleep(700);
              out.levelJaValue =
                document.querySelector('[data-grade-select]')?.getAttribute('data-value') ?? 'none';
              out.levelJa = await levelLabels();
              await pick('[data-target-select]', 'Russian');
              await sleep(700);
              out.levelRu = await levelLabels();
              await pick('[data-target-select]', 'Korean');
              await sleep(700);
              out.levelKo = await levelLabels();
              await pick('[data-target-select]', 'English');
              await sleep(700);
              out.levelBackValue =
                document.querySelector('[data-grade-select]')?.getAttribute('data-value') ?? 'none';
              const settledLevels = await window.copilot.getSettings();
              out.levelBackEnglish = settledLevels.languageLevels.English;
              out.levelStoredJa = settledLevels.languageLevels.Japanese;
              out.levelStoredRu = settledLevels.languageLevels.Russian;
              out.levelStoredKo = settledLevels.languageLevels.Korean;
              out.targetBack = settledLevels.targetLanguage;

              document.querySelector('[data-settings-tab="api"]')?.click();
              await sleep(600);
              out.apiActive =
                document.querySelector('[data-settings-tab="api"]')?.getAttribute('data-active') ===
                'true';
              out.providerSelect = !!document.querySelector('[data-provider-select]');
              out.providerValue =
                document.querySelector('[data-provider-select]')?.getAttribute('data-value') ?? 'none';
              out.modelSelect = !!document.querySelector('[data-model-select]');
              out.modelValue =
                document.querySelector('[data-model-select]')?.getAttribute('data-value') ?? 'none';
              out.apiTestBtn = !!document.querySelector('[data-api-test]');
              out.tutorialBtn = !!document.querySelector('[data-tutorial-btn]');
              out.apiStatus =
                document.querySelector('[data-ai-status]')?.getAttribute('data-ai-status') ?? 'none';
              out.domesticOnly = body().includes('只允许国内') || body().includes('国内服务商');

              // 真的点一次：没有 Key 时必须明确说出「还没有填 API Key」
              document.querySelector('[data-api-test]')?.click();
              await sleep(3200);
              out.testText = (
                document.querySelector('[data-ai-status]')?.textContent ?? ''
              ).slice(0, 140);
              out.sttStatusLine = (() => {
                const nodes = [...document.querySelectorAll('p')];
                return (
                  nodes.find((n) => (n.textContent ?? '').includes('字幕状态'))?.textContent ?? ''
                ).slice(0, 60);
              })();

              document.querySelector('[data-settings-tab="general"]')?.click();
              await sleep(400);
              out.backToGeneral = !!document.querySelector('[data-settings-tab="general"][data-active="true"]');

              // ---- 性能页：端到端时延埋点 ---------------------------------
              // 演示模式走的是本地 mock，不经过真实识别链路，所以这里只能验证
              // 「面板渲染正确、口径文案正确」；真实数字要装了 Key 才会有。
              document.querySelector('[data-settings-tab="perf"]')?.click();
              await sleep(600);
              out.perfTabActive =
                document.querySelector('[data-settings-tab="perf"]')?.getAttribute('data-active') ===
                'true';
              out.perfPanel = !!document.querySelector('[data-perf-panel]');
              out.perfVerdict = (
                document.querySelector('[data-perf-verdict]')?.textContent ?? ''
              ).trim();
              out.perfRtf = (document.querySelector('[data-perf-rtf]')?.textContent ?? '').trim();
              out.perfCount = (document.querySelector('[data-perf-count]')?.textContent ?? '').trim();
              out.perfRows = document.querySelectorAll('[data-perf-row]').length;
              out.perfClearBtn = !!document.querySelector('[data-perf-clear]');
              // 「静音不影响采集」这条实测结论必须真的出现在界面上 ——
              // 用户问的就是这个，光写在代码注释里没用。
              out.perfMentionsRealtime = (document.querySelector('[data-perf-panel]')?.textContent ?? '').includes(
                '实时率',
              );

              // 真实识别测速：这是全套埋点里唯一能拿到「真实数字」的入口，
              // 而且不依赖声卡 —— 点一次，量真实模型 + 网络的往返耗时。
              const probeBtn = () => document.querySelector('[data-perf-probe]');
              const probeText = () =>
                (document.querySelector('[data-perf-probe-result]')?.textContent ?? '').trim();
              out.perfProbeBtn = !!probeBtn();
              out.perfProbeClicks = 0;
              // 必须等「结果文本真的变了」才算测完。
              // 不能用按钮的 disabled 判断：React 的 state 更新不会在 click() 返回
              // 时同步到 DOM，读 disabled 永远读到 false，于是两次点击和两次读取
              // 全挤在同一瞬间，断言拿到的全是空值（已踩过一次）。
              const runProbeOnce = async () => {
                let idleWait = 0;
                while (idleWait < 45000 && (probeBtn()?.textContent ?? '').includes('正在测')) {
                  await sleep(400);
                  idleWait += 400;
                }
                const before = probeText();
                let elapsed = 0;
                if (probeBtn()) {
                  probeBtn().click();
                  out.perfProbeClicks += 1;
                }
                while (elapsed < 45000) {
                  await sleep(400);
                  elapsed += 400;
                  const now = probeText();
                  if (now && now !== before) break;
                }
                return { idleWait, elapsed, after: probeText() };
              };
              if (out.perfProbeBtn) {
                const first = await runProbeOnce();
                out.perfProbeWaitedMs = first.elapsed;
                out.perfProbeResult = first.after.slice(0, 120);
                out.perfProbeOk = !(
                  document.querySelector('[data-perf-probe-result]')?.className ?? ''
                ).includes('bg-danger');

                // 再测一次：单次结果不可信（实测同一个模型 381ms ~ 11177ms），
                // 界面必须给出分布，否则这一页会变成一台随机数发生器。
                const second = await runProbeOnce();
                out.perfProbeSecondWaitedMs = second.elapsed;
                out.perfProbeSpreadShown = !!document.querySelector('[data-perf-probe-spread]');
                out.perfProbeSpread = (
                  document.querySelector('[data-perf-probe-spread]')?.textContent ?? ''
                )
                  .trim()
                  .slice(0, 140);
                // 面板还活着吗？测速期间如果它被别的异步状态关掉，后面所有断言都会
                // 变空 —— 这一项就是为了让下一次诊断一眼看出是"面板没了"还是"功能坏了"。
                out.perfPanelAliveAfterProbe = !!document.querySelector('[data-perf-panel]');
              }

              document.querySelector('[data-settings-tab="general"]')?.click();
              await sleep(400);

              // 硬规则：把接口地址改成境外，主进程必须拒绝（用户要求「只允许国内」）。
              out.foreignRejected = await (async () => {
                try {
                  const current = await window.copilot.getSettings();
                  await window.copilot.setSettings({
                    ai: { ...current.ai, baseURL: 'https://api.openai.com/v1' },
                  });
                  return false; // 竟然被接受了 → 不合格
                } catch {
                  return true; // 被拦下 → 正确
                }
              })();
              // 国内地址必须放行（用同一家的地址，不改变实际配置）。
              out.domesticAccepted = await (async () => {
                try {
                  const current = await window.copilot.getSettings();
                  await window.copilot.setSettings({ ai: { ...current.ai, baseURL: current.ai.baseURL } });
                  return true;
                } catch {
                  return false;
                }
              })();
              [...document.querySelectorAll('button')]
                .find((b) => b.textContent.trim() === '返回')
                ?.click();
              await sleep(500);
              out.settingsClosed = !document.querySelector('[data-settings-tabs]');

              // 截图准备：重新打开设置面板，停在「常用功能」并展开「语言水平」
              // 下拉。主进程紧接着截一张作为「选项全是国内英语等级」的直接证据
              // —— 必须在这里做，因为自检一结束面板就会被后续步骤关掉，那时再
              // 打开去截，容易拍到还没渲染完的中间态。
              [...document.querySelectorAll('button')]
                .find((b) => b.getAttribute('aria-label') === '打开设置')
                ?.click();
              await sleep(900);
              document.querySelector('[data-settings-tab="general"]')?.click();
              await sleep(700);
              document.querySelector('[data-grade-select]')?.click();
              await sleep(700);
              out.reopenedForShot = !!document.querySelector('[data-select-menu]');

              return JSON.stringify(out);
            })()`,
          );
          // 主进程侧的信息（渲染层看不到）：sidecar 最终选了哪个 Python。
          // 「发给朋友能不能直接用」就取决于它是不是安装包自带的那份。
          let report = check;
          try {
            const availability = pythonAvailability();
            const parsed = JSON.parse(String(check)) as Record<string, unknown>;
            parsed.pythonAvailable = availability.available;
            parsed.pythonCommand = availability.command;
            parsed.pythonIsBundled = availability.command.includes('python-runtime');
            report = JSON.stringify(parsed);
          } catch {
            /* 自检本身失败时保持原样 */
          }
          logger.info('App', `SELF CHECK: ${report}`);

          // 自检刻意停在「设置面板打开 + 语言水平下拉展开」的状态，先拍这一张。
          const gradeMenuImage = await win.webContents.capturePage();
          const gradeMenuPath = (process.env.COPILOT_SCREENSHOT as string).replace(
            /\.png$/i,
            '-menu.png',
          );
          fs.writeFileSync(gradeMenuPath, gradeMenuImage.toPNG());
          logger.info('App', `grade menu screenshot saved to ${gradeMenuPath}`);

          // Re-open a reply panel in video mode so the screenshot shows the
          // headline feature: live subtitle bar + pause-to-reply panel.
          await win.webContents.executeJavaScript(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              // 先把设置面板关掉，否则它会盖住主界面截图。
              if (document.querySelector('[data-settings-tabs]')) {
                [...document.querySelectorAll('button')]
                  .find((b) => b.textContent.trim() === '返回')
                  ?.click();
                await sleep(600);
              }
              const chip = [...document.querySelectorAll('button')].find(
                (b) => b.textContent.trim() === '看视频',
              );
              chip?.click();
              await sleep(700);
              const demo = [...document.querySelectorAll('button')].find(
                (b) => b.textContent.trim() === '说一句示例',
              );
              for (let index = 0; index < 3; index += 1) {
                demo?.click();
                await sleep(900);
              }
              document.querySelector('[data-primary-action]')?.click();
              await sleep(2800);
            })()`,
          );
          const image = await win.webContents.capturePage();
          fs.writeFileSync(process.env.COPILOT_SCREENSHOT as string, image.toPNG());
          logger.info('App', `screenshot saved to ${process.env.COPILOT_SCREENSHOT}`);

          // 专门拍一张「关键事实确认卡」展开的样子（视觉证据）。
          await win.webContents.executeJavaScript(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const chip = (label) =>
                [...document.querySelectorAll('button')].find(
                  (b) => b.textContent.trim() === label,
                );
              // 关掉回复面板，否则它会盖住字幕上方的重点信息区。
              [...document.querySelectorAll('button')]
                .find((b) => b.textContent.trim() === '关闭')
                ?.click();
              await sleep(500);
              chip('对话')?.click();
              await sleep(500);
              await window.copilot.setSettings({ facts: { enabled: true, useModel: false } });
              await window.copilot.audioDemoLine(
                'Tomorrow at 3 pm we will have a meeting in the conference room, and remember to bring the 3 copies of the materials.',
              );
              await sleep(3200);
              const toggle = document.querySelector('[data-fact-toggle]');
              if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
                toggle.click();
                await sleep(400);
              }
              document.querySelector('[data-fact-row] input[type="checkbox"]')?.click();
              await sleep(300);
            })()`,
          );
          const factsImage = await win.webContents.capturePage();
          const factsPath = (process.env.COPILOT_SCREENSHOT as string).replace(
            /\.png$/i,
            '-facts.png',
          );
          fs.writeFileSync(factsPath, factsImage.toPNG());
          logger.info('App', `facts screenshot saved to ${factsPath}`);
          // 拍完把提取开关恢复原样，不把自检的设置留给用户。
          await win.webContents.executeJavaScript(
            `window.copilot.setSettings({ facts: { enabled: true, useModel: true } })`,
          );

          // Third shot: the 「API 功能」 settings tab (visual evidence).
          // 「常用功能」和「API 功能」两张合起来就是设置页拆分的证据。
          await win.webContents.executeJavaScript(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              if (!document.querySelector('[data-settings-tabs]')) {
                [...document.querySelectorAll('button')]
                  .find((b) => b.getAttribute('aria-label') === '打开设置')
                  ?.click();
              }
              await sleep(900);
              document.querySelector('[data-settings-tab="general"]')?.click();
              await sleep(900);
              // 面板重开过，体检结果在上一次挂载里已经没了 —— 重新点一次诊断，
              // 并把结果滚进画面，截图才有「点了才出、只列问题」的证据。
              const shotBtn = document.querySelector('[data-health-run-settings]');
              if (shotBtn) {
                shotBtn.click();
                let shotWait = 0;
                while (shotWait < 30000 && !document.querySelector('[data-health-report]')) {
                  await sleep(500);
                  shotWait += 500;
                }
              }
              const shotReport = document.querySelector('[data-health-report]');
              // scrollIntoView 在这个面板上不可靠（滚动容器是设置页那一层），
              // 直接找最近的滚动祖先再按 rect 差值滚，截图才稳定落在体检结果上。
              if (shotReport) {
                let node = shotReport.parentElement;
                while (node) {
                  const style = getComputedStyle(node);
                  if (
                    /(auto|scroll)/.test(style.overflowY) &&
                    node.scrollHeight > node.clientHeight + 20
                  ) {
                    node.scrollTop +=
                      shotReport.getBoundingClientRect().top -
                      node.getBoundingClientRect().top -
                      70;
                    break;
                  }
                  node = node.parentElement;
                }
              }
              await sleep(600);
            })()`,
          );
          const generalImage = await win.webContents.capturePage();
          const generalPath = (process.env.COPILOT_SCREENSHOT as string).replace(
            /\.png$/i,
            '-general.png',
          );
          fs.writeFileSync(generalPath, generalImage.toPNG());
          logger.info('App', `general screenshot saved to ${generalPath}`);

          await win.webContents.executeJavaScript(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              document.querySelector('[data-settings-tab="api"]')?.click();
              await sleep(1200);
            })()`,
          );
          const apiImage = await win.webContents.capturePage();
          const apiPath = (process.env.COPILOT_SCREENSHOT as string).replace(/\.png$/i, '-api.png');
          fs.writeFileSync(apiPath, apiImage.toPNG());
          logger.info('App', `api screenshot saved to ${apiPath}`);

          // Fifth shot: the 「性能」 tab (端到端时延埋点).
          await win.webContents.executeJavaScript(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              document.querySelector('[data-settings-tab="perf"]')?.click();
              await sleep(1200);
            })()`,
          );
          const perfImage = await win.webContents.capturePage();
          const perfPath = (process.env.COPILOT_SCREENSHOT as string).replace(/\.png$/i, '-perf.png');
          fs.writeFileSync(perfPath, perfImage.toPNG());
          logger.info('App', `perf screenshot saved to ${perfPath}`);
        } catch (error) {
          logger.error('App', `screenshot failed: ${String(error)}`);
        }
        app.quit();
      }, 20000);
    }
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    destroyTray();
    disposeAudio();
    /*
     * 记录库正常关闭。
     *
     * 注意：**不能**只靠这一步来保存数据。真正的保存发生在每条消息定稿时
     * （渲染层通过 history:upsert 立刻写入并等回执），退出时关库只是把
     * 文件句柄收干净。异常退出（断电 / 进程被杀）时，已经 COMMIT 的数据
     * 仍在文件里，这是 SQLite 回滚日志保证的。
     */
    closeHistoryStore();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
