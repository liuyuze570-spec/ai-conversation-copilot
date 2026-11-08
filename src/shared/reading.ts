/**
 * 字幕阅读区的排版规则（纯函数，能直接单测）。
 *
 * 这一版把「三行字」彻底拆开：外语原文、中文译文、中文近似音（谐音）各有
 * 自己的字号，互不影响，范围统一 12–64px。
 *
 * 为什么必须拆开：
 *  - 旧版译文固定「原文减 2px」、谐音固定「原文减 3px」。用户把原文调到 40px
 *    想看外语，译文跟着变 38px —— 但他真正需要看清的是中文；
 *  - 反过来把译文调大，谐音又被一起推大，三行抢同一块高度，字幕反而看得更少。
 *
 * 这里的「中文近似音」是给外语标的**中文谐音**（不是译文，也不是汉语拼音），
 * 例如 "How are you doing?" → 「好 阿 优 度英」。它是近似，不等同准确发音。
 */

/** 三类文字共用的范围。上限 64px 是 460px 宽窗口里仍能读到的极限。 */
export const FONT_MIN = 12;
export const FONT_MAX = 64;

/** 默认值：原文 18 / 译文 24 / 谐音 18。译文是主阅读对象，默认最大。 */
export const ORIGINAL_FONT_DEFAULT = 18;
export const TRANSLATION_FONT_DEFAULT = 24;
export const ROMANIZATION_FONT_DEFAULT = 18;

export type FontTarget = 'original' | 'translation' | 'romanization';

export const FONT_TARGETS: {
  value: FontTarget;
  label: string;
  short: string;
  hint: string;
  dataAttr: string;
}[] = [
  {
    value: 'original',
    label: '外语原文字号',
    short: '原文',
    hint: '对方说的外语原文（英语等）',
    dataAttr: 'data-font-target-original',
  },
  {
    value: 'translation',
    label: '中文译文字号',
    short: '译文',
    hint: '翻译出来的中文，主要阅读对象',
    dataAttr: 'data-font-target-translation',
  },
  {
    value: 'romanization',
    label: '中文近似音字号',
    short: '谐音',
    hint: '给外语标的中文谐音（近似读音，不是译文）',
    dataAttr: 'data-font-target-romanization',
  },
];

export type ReadingMode = 'both' | 'translation-first' | 'original-only';

export const READING_MODES: { value: ReadingMode; label: string; hint: string }[] = [
  {
    value: 'both',
    label: '原文 + 译文',
    hint: '外语原文在上、中文译文在下，各自按自己的字号显示',
  },
  {
    value: 'translation-first',
    label: '先看译文',
    hint: '中文译文在上，外语原文缩到下面，适合只想快速抓住意思',
  },
  {
    value: 'original-only',
    label: '只看外语原文',
    hint: '不显示中文译文，适合练听力核对',
  },
];

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 三类文字共用一个钳制函数：范围必须一致，不能再各自一套。 */
export function clampFont(value: number): number {
  return clampNumber(value, FONT_MIN, FONT_MAX);
}

/** 兼容旧调用点。 */
export const clampTranslationFont = clampFont;
export const clampOriginalFont = clampFont;

export interface ReadingPrefs {
  originalFontSize: number;
  translationFontSize: number;
  romanizationFontSize: number;
  readingMode: ReadingMode;
  highContrast: boolean;
}

export interface SubtitleLike {
  /** 旧字段（0.3.x 只有一个字号）。迁移时只用来决定原文。 */
  fontSize?: number;
  originalFontSize?: number;
  translationFontSize?: number;
  romanizationFontSize?: number;
  readingMode?: ReadingMode;
  highContrast?: boolean;
  showTranslation?: boolean;
}

/**
 * 把（可能是旧版）设置规整成一份完整的阅读偏好。
 *
 * 老设置只有一个 `fontSize`（0.3.x 默认 15，0.4.0 起默认原文 15 / 译文 23）。
 * 迁移规则：
 *  - 老字段只决定**原文**，不允许再推到译文上（那正是要改掉的那件事）；
 *  - 谐音没有历史值，一律从 18 起步；
 *  - 如果某个值恰好等于上一版的默认值（15 / 23），说明用户没有主动改过，
 *    直接升到这一版的默认（18 / 24），否则一律保留用户自己的选择。
 */
export function readingPrefs(subtitle: SubtitleLike): ReadingPrefs {
  const legacy = typeof subtitle.fontSize === 'number' ? subtitle.fontSize : undefined;

  const rawOriginal =
    typeof subtitle.originalFontSize === 'number'
      ? subtitle.originalFontSize
      : (legacy ?? ORIGINAL_FONT_DEFAULT);
  const rawTranslation =
    typeof subtitle.translationFontSize === 'number'
      ? subtitle.translationFontSize
      : TRANSLATION_FONT_DEFAULT;
  const rawRomanization =
    typeof subtitle.romanizationFontSize === 'number'
      ? subtitle.romanizationFontSize
      : ROMANIZATION_FONT_DEFAULT;

  /*
   * 这里**只做范围钳制，不做版本迁移**。
   *
   * 0.5.0 把「15 → 18 / 23 → 24」写在渲染路径上，读一次改一次：
   * 用户主动把原文调成 15px（窄窗口里想多显示两行），下次打开又被改回 18，
   * 而界面上没有任何说明。迁移属于「一次性的设置修复」，已经挪到
   * `main/settings-store.ts#migrateReading()`，由 `readingVersion` 控制只跑一次。
   *
   * 所以这里 15 就是 15、23 就是 23：用户选什么就显示什么。
   */
  return {
    originalFontSize: clampFont(rawOriginal),
    translationFontSize: clampFont(rawTranslation),
    romanizationFontSize: clampFont(rawRomanization),
    readingMode: subtitle.readingMode ?? 'both',
    highContrast: subtitle.highContrast ?? false,
  };
}

/** 取某一类文字的字号。界面上的 A+/A− 用它决定改哪一个。 */
export function fontSizeOf(prefs: ReadingPrefs, target: FontTarget): number {
  if (target === 'original') return prefs.originalFontSize;
  if (target === 'translation') return prefs.translationFontSize;
  return prefs.romanizationFontSize;
}

/**
 * 调一类字号，**不动另外两类**。
 *
 * 返回新的 prefs，方便界面直接写回设置 —— 也方便单测断言「调译文不动原文」。
 */
export function adjustFontSize(
  prefs: ReadingPrefs,
  target: FontTarget,
  delta: number,
): ReadingPrefs {
  const next = clampFont(fontSizeOf(prefs, target) + delta);
  if (target === 'original') return { ...prefs, originalFontSize: next };
  if (target === 'translation') return { ...prefs, translationFontSize: next };
  return { ...prefs, romanizationFontSize: next };
}

/** 三类里最大的那个 —— 决定底栏要不要精简。 */
export function maxFontSize(prefs: ReadingPrefs): number {
  return Math.max(
    prefs.originalFontSize,
    prefs.translationFontSize,
    prefs.romanizationFontSize,
  );
}

/** 译文是不是主阅读对象（决定译文在上、以及空位时先给谁）。 */
export function translationIsPrimary(prefs: ReadingPrefs): boolean {
  return prefs.readingMode !== 'original-only';
}

// ---------------------------------------------------------------------------
// 对比度
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const clean = hex.trim().replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((char) => char + char)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

/**
 * 半透明文字压到底色上之后的实际颜色。
 *
 * 直接拿 `#ffffff` 和底色算对比度会得出一个虚假的好成绩 —— 界面上那行
 * 字真正显示出来是 `white/45`，也就是 45% 的白压在深底上。必须先把 alpha
 * 合成进来，算出来的才是用户眼睛看到的对比度。
 */
export function compositeOver(fgHex: string, alpha: number, bgHex: string): Rgb {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
  };
}

/** WCAG 相对亮度。 */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 对比度：1:1 ～ 21:1。正文建议 ≥ 4.5，大字号 ≥ 3。 */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

export function contrastOf(fgHex: string, alpha: number, bgHex: string): number {
  return contrastRatio(compositeOver(fgHex, alpha, bgHex), hexToRgb(bgHex));
}

/**
 * 把 CSS 计算出来的颜色（`rgb()` / `rgba()` / `#rrggbb`）转成 Rgb + alpha。
 *
 * 存在的理由：文档里写「21:1 实测」没有意义，必须能拿**浏览器真正渲染出来的**
 * 颜色去算。自检脚本从 getComputedStyle 读到 `rgb(255, 255, 255)` 之后走这里。
 */
export function parseCssColor(input: string): { rgb: Rgb; alpha: number } | null {
  const text = input.trim();
  if (!text) return null;
  if (text.startsWith('#')) {
    return { rgb: hexToRgb(text), alpha: 1 };
  }
  const match = text.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const alpha = parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
  return { rgb: { r: parts[0], g: parts[1], b: parts[2] }, alpha };
}

/** 用真实渲染出来的前景/背景色算对比度（自检用）。 */
export function contrastOfCss(foreground: string, background: string): number | null {
  const fg = parseCssColor(foreground);
  const bg = parseCssColor(background);
  if (!fg || !bg) return null;
  // 背景若也是半透明，先按最坏情况压在黑底上，避免高估。
  const bgRgb = bg.alpha < 1 ? compositeOver('#000000', bg.alpha, '#000000') : bg.rgb;
  const fgRgb =
    fg.alpha < 1
      ? compositeOver(`#${[fg.rgb.r, fg.rgb.g, fg.rgb.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`, fg.alpha, `#${[bgRgb.r, bgRgb.g, bgRgb.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`)
      : fg.rgb;
  return contrastRatio(fgRgb, bgRgb);
}

/**
 * 实际使用的文字颜色（含透明度）。
 *
 * 关键点：**译文不因为「是译文」而被压暗**。高对比模式下原文、译文、谐音
 * 全部纯白，底色压到纯黑 —— 而且这个「纯黑」是界面真的渲染出来的底色，
 * 不只是这里算出来的数字（见 styles.css 的 `[data-contrast='high']`）。
 */
export const TEXT_TOKENS = {
  normal: {
    background: '#0b0e14',
    original: { color: '#ffffff', alpha: 0.96 },
    translation: { color: '#ffffff', alpha: 0.9 },
    romanization: { color: '#9db2ff', alpha: 0.8 },
    secondary: { color: '#ffffff', alpha: 0.55 },
  },
  high: {
    background: '#000000',
    original: { color: '#ffffff', alpha: 1 },
    translation: { color: '#ffffff', alpha: 1 },
    romanization: { color: '#ffffff', alpha: 1 },
    secondary: { color: '#ffffff', alpha: 0.86 },
  },
} as const;

export function textTokens(highContrast: boolean) {
  return highContrast ? TEXT_TOKENS.high : TEXT_TOKENS.normal;
}

/**
 * 阅读区高度是否已经很紧 —— 决定要不要把次要区收起来。
 *
 * 460×640 的悬浮窗里，译文 40px 时一行就能占掉 60px 以上。这时候还留着
 * 语气选择、场景切换、中文输入框，字幕会被压到只剩一两行；用户调大字号
 * 本来就是为了看清，结果看到的更少。
 */
export function needsCompactChrome(fontSize: number): boolean {
  return fontSize >= 26;
}

/** 更紧的一档：原文 40px 以上时连「更多」一起收起，只留沟通卡。 */
export function needsMinimalChrome(fontSize: number): boolean {
  return fontSize >= 40;
}
