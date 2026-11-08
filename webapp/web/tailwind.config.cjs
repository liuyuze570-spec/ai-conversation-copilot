/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // 与桌面端同一套色板，保证「风格保持一致」不是口头承诺。
      colors: {
        ink: {
          950: '#0b0e14',
          900: '#11151d',
          850: '#161b25',
          800: '#1c222e',
          700: '#252c3a',
          600: '#333b4c',
        },
        accent: {
          DEFAULT: '#6f8cff',
          soft: '#9db1ff',
          deep: '#3f5bd9',
        },
        warn: '#ffb020',
        danger: '#ff6b6b',
        ok: '#3ddc97',
      },
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [String(index), String(index / 100)]),
      ),
    },
  },
  plugins: [],
};
