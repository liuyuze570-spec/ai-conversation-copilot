import { app, Menu, Tray, type BrowserWindow } from 'electron';
import { createTrayIcon } from './tray-icon';
import { getSettingsStore } from './settings-store';
import { resetOverlayPosition } from './overlay-window';
import { logger } from './logger';

let tray: Tray | null = null;

export function createTray(getWindow: () => BrowserWindow | null) {
  if (tray) return tray;

  try {
    tray = new Tray(createTrayIcon());
  } catch (error) {
    logger.error('Tray', `failed to create tray: ${String(error)}`);
    return null;
  }

  tray.setToolTip('AI Conversation Copilot');

  const show = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const menu = Menu.buildFromTemplate([
    { label: '显示 / 置前', click: show },
    {
      label: '重置窗口位置',
      click: () => {
        resetOverlayPosition();
        show();
      },
    },
    {
      label: '开始 / 暂停监听',
      click: () => {
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send('tray:toggle-listening');
        }
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', show);
  logger.info('Tray', 'tray icon created');
  return tray;
}

export function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

export function updateTrayTooltip(status: string) {
  if (!tray) return;
  tray.setToolTip(`AI Conversation Copilot · ${status}`);
  void getSettingsStore();
}
