/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      /**
       * 透明度刻度补全到 0–100 的每一个整数。
       *
       * 这是一个真实的坑：Tailwind 3.4 默认的 opacity 刻度只有 5 的倍数，
       * 所以 `bg-white/8`、`border-white/6`、`bg-danger/12` 这类写法**不会报错、
       * 也不会生成任何 CSS** —— 静默失效。界面因此到处缺描边和底色，看起来
       * 「层级糊在一起、不精致」。补齐之后这些值才真的生效。
       */
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [String(index), String(index / 100)]),
      ),
      colors: {
        /**
         * 表面层级。
         *
         * 设计约束：整个界面只用 ink-950 → ink-600 这几档做「深」，不再随手写
         * bg-white/[0.03] 这种即兴透明度 —— 之前正是到处即兴取值，层级才糊成
         * 一片、没有高级感。数字越大越亮，越靠近用户。
         */
        ink: {
          950: '#0b0e14',
          900: '#11151d',
          850: '#161b25',
          800: '#1c222e',
          700: '#252c3a',
          600: '#333b4c',
        },
        /** 描边三档：soft 分区、DEFAULT 卡片、strong 交互态。 */
        line: {
          soft: 'rgba(255, 255, 255, 0.06)',
          DEFAULT: 'rgba(255, 255, 255, 0.10)',
          strong: 'rgba(255, 255, 255, 0.18)',
        },
        /** 强调色：靛蓝→紫的低饱和区间，年轻但不刺眼。 */
        accent: {
          DEFAULT: '#6d8bff',
          soft: '#9db2ff',
          dim: '#4a62c8',
        },
        /** 语义色：ok=正在听、warn=暂停/演示、danger=出错。 */
        ok: '#3ddc97',
        warn: '#fbbf24',
        danger: '#fb7185',
        /** 兼容旧类名（bg-glass-900 等），值统一对齐到 ink 层级。 */
        glass: {
          900: 'rgba(11, 14, 20, 0.94)',
          800: 'rgba(22, 27, 37, 0.86)',
          700: 'rgba(37, 44, 58, 0.70)',
        },
      },
      fontFamily: {
        sans: [
          '"Segoe UI Variable Display"',
          '"Segoe UI"',
          'Inter',
          'system-ui',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', '"Cascadia Mono"', 'Consolas', 'monospace'],
      },
      borderRadius: {
        // 圆角节奏：8 / 12 / 16 / 20，够用且不凌乱。
        xl: '12px',
        '2xl': '16px',
        '3xl': '20px',
      },
      boxShadow: {
        // 高级感来自「深而不脏」的阴影，不是发光。
        lift: '0 8px 24px -8px rgba(0, 0, 0, 0.55)',
        panel: '0 24px 60px -20px rgba(0, 0, 0, 0.7)',
      },
      keyframes: {
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        pulse_dot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        /** 监听中：细竖条呼吸，比整块闪烁克制得多。 */
        breathe: {
          '0%, 100%': { transform: 'scaleY(0.45)', opacity: '0.6' },
          '50%': { transform: 'scaleY(1)', opacity: '1' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 160ms ease-out',
        'pulse-dot': 'pulse_dot 1.4s ease-in-out infinite',
        breathe: 'breathe 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
