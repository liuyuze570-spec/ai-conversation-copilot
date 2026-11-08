import path from 'node:path';
import {
  BrowserWindow,
  screen,
  shell,
  app,
  type BrowserWindowConstructorOptions,
} from 'electron';
import { getSettingsStore } from './settings-store';
import { logger } from './logger';
import { registerAudioIpc, stopAudioPipeline } from './audio/audio-controller';

const DEFAULT_WIDTH = 460;
const DEFAULT_HEIGHT = 640;
const COMPACT_WIDTH = 400;
const COMPACT_HEIGHT = 300;

let overlay: BrowserWindow | null = null;

function defaultPosition(width: number, height: number) {
  // Put the overlay on the display the user is actually looking at (cursor),
  // not necessarily the primary one.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor).workArea;
  return {
    x: Math.max(display.x + 24, display.x + display.width - width - 48),
    y: display.y + 48,
  };
}

/** A saved position can end up off-screen (monitor change / smaller display). */
function isOnScreen(x: number, y: number): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      x >= area.x - 40 &&
      x <= area.x + area.width - 60 &&
      y >= area.y - 40 &&
      y <= area.y + area.height - 80
    );
  });
}

function windowOptions(): BrowserWindowConstructorOptions {
  const settings = getSettingsStore().get();
  const bounds = settings.window.bounds;

  const width = Math.min(bounds?.width ?? DEFAULT_WIDTH, 900);
  const height = Math.min(bounds?.height ?? DEFAULT_HEIGHT, 1000);
  const fallback = defaultPosition(width, height);
  const savedOk = bounds ? isOnScreen(bounds.x, bounds.y) : false;
  const x = savedOk && bounds ? bounds.x : fallback.x;
  const y = savedOk && bounds ? bounds.y : fallback.y;

  if (bounds && !savedOk) {
    logger.warn('Window', `saved position ${bounds.x},${bounds.y} is off-screen, reset`);
  }

  return {
    x,
    y,
    width,
    height,
    minWidth: 320,
    minHeight: 220,
    frame: false,
    // NOTE: `transparent: true` renders an invisible window when GPU
    // acceleration is disabled (sandboxed / RDP machines) — the compositor
    // never draws the translucent surface. An opaque dark window is always
    // visible, which matters far more than the glass effect.
    transparent: false,
    backgroundColor: '#12141c',
    hasShadow: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    skipTaskbar: false,
    title: 'AI Conversation Copilot',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  };
}

export function createOverlayWindow(): BrowserWindow {
  overlay = new BrowserWindow(windowOptions());
  const settings = getSettingsStore().get();

  overlay.setAlwaysOnTop(settings.window.alwaysOnTop, 'screen-saver');
  overlay.setOpacity(Math.min(1, Math.max(0.35, settings.window.opacity)));
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  /*
   * 外部链接交给系统浏览器，但**只放行 http / https**。
   *
   * 旧实现是 `shell.openExternal(url)` 无条件打开：页面里任何一个
   * `<a href="file:///...">`、`smb://`、`ms-msdt:` 都会被真的交给操作系统执行
   * —— 这类「协议处理器」正是钓鱼和本地提权的常用入口。现在非 http(s) 一律拒绝。
   */
  overlay.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    } else {
      logger.warn('Window', `blocked external protocol: ${url.slice(0, 80)}`);
    }
    return { action: 'deny' };
  });

  /*
   * 不允许窗口自己被导航走。
   *
   * 把文件拖进窗口、或者页面里一次意外的 location 赋值，都会让整个应用
   * 变成一个「浏览器」—— 界面消失、preload 的 API 也没了，用户只会看到白屏。
   * 只允许留在自己的页面里（开发态是自己那个 dev server）。
   */
  overlay.webContents.on('will-navigate', (event, url) => {
    const current = overlay?.webContents.getURL() ?? '';
    if (url === current) return;
    event.preventDefault();
    logger.warn('Window', `blocked navigation to ${url.slice(0, 80)}`);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    overlay.loadURL(devUrl).catch((error) => {
      logger.error('Window', `load dev url failed: ${String(error)}`);
    });
  } else {
    overlay.loadURL('copilot://renderer/index.html').catch((error) => {
      logger.error('Window', `load production file failed: ${String(error)}`);
    });
  }

  // Surface renderer console output in the main log for diagnostics.
  overlay.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    logger.info('RendererConsole', `${message} (${sourceId}:${line})`);
  });
  overlay.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Window', `renderer gone: ${JSON.stringify(details)}`);
  });

  overlay.once('ready-to-show', () => {
    if (!overlay) return;
    overlay.show();
    overlay.focus();
    overlay.moveTop();
    const bounds = overlay.getBounds();
    const displays = screen.getAllDisplays().length;
    logger.info(
      'Window',
      `overlay ready at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} ` +
        `(opacity=${settings.window.opacity}, displays=${displays})`,
    );
  });

  overlay.on('close', () => {
    if (!overlay) return;
    const bounds = overlay.getBounds();
    getSettingsStore().update({
      window: { ...getSettingsStore().get().window, bounds },
    });
    logger.info('Window', `bounds saved: ${JSON.stringify(bounds)}`);
  });

  overlay.on('closed', () => {
    overlay = null;
  });

  registerAudioIpc(overlay);

  return overlay;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlay;
}

export function setOverlayOpacity(opacity: number) {
  const clamped = Math.min(1, Math.max(0.35, opacity));
  overlay?.setOpacity(clamped);
  getSettingsStore().update({
    window: { ...getSettingsStore().get().window, opacity: clamped },
  });
}

export function setOverlayAlwaysOnTop(enabled: boolean) {
  overlay?.setAlwaysOnTop(enabled, 'screen-saver');
  getSettingsStore().update({
    window: { ...getSettingsStore().get().window, alwaysOnTop: enabled },
  });
}

export function setOverlayLocked(locked: boolean) {
  getSettingsStore().update({
    window: { ...getSettingsStore().get().window, locked },
  });
}

export function applyUiMode(mode: 'compact' | 'advanced') {
  if (!overlay) return;
  const [width, height] = overlay.getSize();
  if (mode === 'compact') {
    overlay.setSize(COMPACT_WIDTH, Math.min(height, COMPACT_HEIGHT));
  } else {
    overlay.setSize(Math.max(width, DEFAULT_WIDTH), Math.max(height, DEFAULT_HEIGHT));
  }
}

export function resetOverlayPosition() {
  if (!overlay || overlay.isDestroyed()) return;
  const [width, height] = overlay.getSize();
  const { x, y } = defaultPosition(width, height);
  overlay.setPosition(x, y);
  overlay.show();
  overlay.focus();
  getSettingsStore().update({
    window: { ...getSettingsStore().get().window, bounds: { x, y, width, height } },
  });
  logger.info('Window', `position reset to ${x},${y}`);
}

export function resizeOverlay(width: number, height: number) {
  if (!overlay) return;
  const min = overlay.getMinimumSize();
  overlay.setSize(Math.max(min[0], width), Math.max(min[1], height));
}

export function shutdownWindow() {
  try {
    stopAudioPipeline();
  } catch (error) {
    logger.error('Window', `stop audio failed: ${String(error)}`);
  }
  if (overlay && !overlay.isDestroyed()) {
    const bounds = overlay.getBounds();
    getSettingsStore().update({
      window: { ...getSettingsStore().get().window, bounds },
    });
  }
  app.quit();
}
