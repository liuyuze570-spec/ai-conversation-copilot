import { app, BrowserWindow } from 'electron';
import { getOverlayWindow } from './overlay-window';
import { getSettingsStore } from './settings-store';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * 0.6.3 采集状态与中文草稿的真界面检查（打包版 / 源码版通用）。
 *
 * COPILOT_V063_CHECK=<输出目录> 触发，跑完把 check.json 写到输出目录后退出。
 * 全程演示模式，不碰真实接口 / 麦克风 / 真实设置。
 *
 * 验证的是 0.6.3 这一轮的三处核心修复：
 *  1. 启动后不自动采集，停在「未开始采集」，主按钮写「开始采集」；
 *  2. 点「开始采集」→ 状态进入采集中；点「停止采集」→ 回到已停止；
 *  3. 中文「转成外语」提交后，输入框草稿不清空（保留到成功），出现状态条。
 */
export async function runV063CaptureCheck(): Promise<void> {
  const win = getOverlayWindow();
  if (!win) {
    app.quit();
    return;
  }

  const outDir = process.env.COPILOT_V063_CHECK;
  if (!outDir) {
    app.quit();
    return;
  }
  const results: { name: string; data: unknown }[] = [];

  const js = async <T>(code: string): Promise<T> => {
    try {
      return (await win.webContents.executeJavaScript(code)) as T;
    } catch (error) {
      return null as unknown as T;
    }
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const record = (name: string, data: unknown) => results.push({ name, data });

  try {
    // 进入演示模式，避免依赖真实音频；demo 不自动播放。
    getSettingsStore().update({ mockMode: true, demoAutoPlay: false });
    win.reload();
    for (let i = 0; i < 40; i += 1) {
      if (await js('!!document.querySelector("[data-quick-actions]")')) break;
      await sleep(300);
    }
    await sleep(1000);

    // 1. 启动后：不自动采集，按钮写「开始采集」，阶段是 not-started。
    record('1-boot-not-autostarted', await js(`
      (() => {
        const bar = document.querySelector('[data-source-bar]');
        const btn = document.querySelector('[data-listen-toggle]');
        const phase = bar ? bar.getAttribute('data-capture-phase') : null;
        const active = bar ? bar.getAttribute('data-capture-active') : null;
        return {
          phase,
          active,
          buttonText: btn ? btn.textContent.trim() : null,
          buttonAria: btn ? btn.getAttribute('aria-label') : null,
        };
      })()
    `));

    // 2. 点「开始采集」→ 进入采集中（mock 引擎会进入 listening）。
    await js(`(document.querySelector('[data-listen-toggle]')||{}).click && document.querySelector('[data-listen-toggle]').click()`);
    await sleep(1500);
    record('2-after-start', await js(`
      (() => {
        const bar = document.querySelector('[data-source-bar]');
        const btn = document.querySelector('[data-listen-toggle]');
        return {
          phase: bar ? bar.getAttribute('data-capture-phase') : null,
          active: bar ? bar.getAttribute('data-capture-active') : null,
          buttonText: btn ? btn.textContent.trim() : null,
        };
      })()
    `));

    // 3. 点「停止采集」→ 回到已停止，按钮变回「开始采集」。
    await js(`(document.querySelector('[data-listen-toggle]')||{}).click && document.querySelector('[data-listen-toggle]').click()`);
    await sleep(1200);
    record('3-after-stop', await js(`
      (() => {
        const bar = document.querySelector('[data-source-bar]');
        const btn = document.querySelector('[data-listen-toggle]');
        return {
          phase: bar ? bar.getAttribute('data-capture-phase') : null,
          active: bar ? bar.getAttribute('data-capture-active') : null,
          buttonText: btn ? btn.textContent.trim() : null,
        };
      })()
    `));

    // 4. 中文输入提交后草稿保留（演示模式也会返回 3 条）。
    record('4-chinese-draft', await js(`
      (async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // 展开「更多」
        const more = document.querySelector('[data-more-toggle]');
        if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
        await sleep(200);
        const input = document.querySelector('[data-quick-actions] input[placeholder^="输入"]');
        if (!input) return { noInput: true };
        input.focus();
        // 直接 set value + dispatch input
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '请确认定金是450欧元');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(100);
        const submit = document.querySelector('[data-chinese-submit]');
        if (!submit) return { noSubmit: true };
        submit.click();
        await sleep(150);
        // 提交后立刻读：输入框是否保留原文 + 是否出现状态条
        const valueAfter = input.value;
        const status = document.querySelector('[data-compose-status]');
        return {
          valueKept: valueAfter === '请确认定金是450欧元',
          valueAfter,
          hasStatus: !!status,
          phase: status ? status.getAttribute('data-compose-phase') : null,
        };
      })()
    `));

    // 等 mock 回复返回，验证状态条进入 success 且草稿被清空
    await sleep(2500);
    record('5-chinese-after-reply', await js(`
      (() => {
        const status = document.querySelector('[data-compose-status]');
        const input = document.querySelector('[data-quick-actions] input[placeholder^="输入"]');
        return {
          phase: status ? status.getAttribute('data-compose-phase') : null,
          inputValueAfter: input ? input.value : null,
        };
      })()
    `));
  } catch (error) {
    record('exception', { message: String(error) });
  }

  const report = path.join(outDir, 'check.json');
  fs.writeFileSync(report, JSON.stringify(results, null, 2), 'utf8');
  // 还原设置后退出。
  setTimeout(() => app.quit(), 300);
}
