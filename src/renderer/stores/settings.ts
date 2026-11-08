import { create } from 'zustand';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * 保存设置。会抛出带中文说明的错误（例如「接口地址不被允许：…」），
   * 调用方负责显示，避免静默失败。
   */
  update: (patch: Partial<Settings>) => Promise<void>;
  setApiKey: (key: string, target?: 'llm' | 'stt') => Promise<void>;
}

/** IPC 抛出来的错误会包一层英文前缀，这里剥掉，只留人话。 */
export function cleanIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    const settings = await window.copilot.getSettings();
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    const merged = await window.copilot.setSettings(patch);
    set({ settings: merged });
  },

  setApiKey: async (key, target = 'llm') => {
    await window.copilot.setApiKey(key, target);
  },
}));
