import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * 网页是一个独立入口，复用桌面端 `src/shared` 与 `src/services` 里的纯函数
 * （事实提取、语言方向、读音规则、三组样例）。
 *
 * 为什么要单独一份 vite 配置：桌面的入口在 `src/renderer`，依赖 `window.copilot`；
 * 网页没有 Electron 能力，必须走 `src/web-adapter`。两者共用代码但构建产物互不影响，
 * 桌面包继续用原来的 `vite.renderer.config.ts`。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 共享模块统一走别名，避免 `../../../../src/shared` 这种路径。
      '@shared': path.resolve(__dirname, '../../src/shared'),
      '@services': path.resolve(__dirname, '../../src/services'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发期把 /api 代理到本机 FastAPI，避免 CORS 与跨域 Cookie 问题。
      '/api': {
        target: process.env.COPILOT_API || 'http://127.0.0.1:8000',
        changeOrigin: false,
      },
    },
    fs: {
      // 允许读取仓库根目录下的共享模块。
      allow: [path.resolve(__dirname, '..'), path.resolve(__dirname, '../..')],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
