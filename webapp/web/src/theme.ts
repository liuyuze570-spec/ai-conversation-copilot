/**
 * 三主题：白色 / 深夜 / 护眼暖色，外加「跟随系统」。
 *
 * 只把 `data-theme` 写到 body 上，颜色全由 CSS 变量接管；不卸载任何组件，
 * 因此切换主题不会清空当前字幕、事实卡和回复卡。选择存 localStorage，
 * 跟随系统时监听系统偏好变化。
 */

export type ThemePref = 'system' | 'light' | 'dark' | 'warm';
export type ThemeName = 'light' | 'dark' | 'warm';

const KEY = 'copilot.theme.v1';
const DARK_QUERY = '(prefers-color-scheme: dark)';

export const THEME_OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: 'system', label: '跟随系统', hint: '系统切到深色时自动切到深夜模式' },
  { value: 'light', label: '白色模式', hint: '柔和浅色背景、深色文字' },
  { value: 'dark', label: '深夜模式', hint: '深色背景、清晰浅色文字' },
  { value: 'warm', label: '护眼暖色', hint: '暖米色低眩光配色；只是配色，不作医学效果承诺' },
];

export function readThemePref(): ThemePref {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'system' || saved === 'light' || saved === 'dark' || saved === 'warm') {
      return saved;
    }
  } catch {
    /* 隐私模式禁用存储时用默认值 */
  }
  return 'system';
}

export function saveThemePref(pref: ThemePref): void {
  try {
    window.localStorage.setItem(KEY, pref);
  } catch {
    /* 存不了就只在本次会话生效 */
  }
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): ThemeName {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

/** 把当前主题写到 body；返回实际生效的主题名，供界面显示。 */
export function applyTheme(pref: ThemePref, systemDark: boolean): ThemeName {
  const resolved = resolveTheme(pref, systemDark);
  document.body.dataset.theme = resolved;
  return resolved;
}

/** 跟随系统时订阅偏好变化；返回取消订阅函数。 */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  // 老 Safari 只有 addListener；不支持就退化为「只在加载时读一次」。
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }
  media.addListener(handler);
  return () => media.removeListener(handler);
}
