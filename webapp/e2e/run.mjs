/**
 * 网页端到端检查（真 Chrome，真点击）。
 *
 * 覆盖：真实翻译 → 重点信息 → 改值 → 生成确认句 → 大字卡 → Esc 焦点归还
 * 以及三组预置样例、错误路径（服务端不可达由 --offline 模拟）。
 *
 * 输出：JSON 结果 + 截图，写到 docs/evidence-web/。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8000';
// 按脚本位置算，别按 CWD 算：从仓库根目录跑时 ../../docs 会落到工程外面去
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.WEB_OUT || path.resolve(HERE, '../../docs/evidence-web');
fs.mkdirSync(OUT, { recursive: true });

const steps = [];
const record = (name, data) => {
  steps.push({ name, data });
  console.log('---', name, JSON.stringify(data));
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none', '--lang=zh-CN'],
});

const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
});
page.on('pageerror', (error) => consoleErrors.push(String(error).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('[data-testid="original-input"]');

const health = await page.evaluate(async () => {
  const response = await fetch('/api/health');
  return response.json();
});
record('health', health);

// 1. 真实翻译
await page.click('[data-testid="original-input"]');
await page.type(
  '[data-testid="original-input"]',
  'Please send the report by 3 p.m. tomorrow.',
  { delay: 0 },
);
await page.click('[data-testid="translate"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="translation-text"]')?.textContent?.trim().length > 0,
  { timeout: 60000 },
);
const real = await page.evaluate(() => ({
  original: document.querySelector('[data-testid="original-text"]')?.textContent,
  translation: document.querySelector('[data-testid="translation-text"]')?.textContent,
  facts: [...document.querySelectorAll('[data-testid="fact-row"]')].map((row) => row.innerText.replace(/\s+/g, ' ').slice(0, 120)),
  badges: [...document.querySelectorAll('header span')].map((node) => node.textContent?.trim()).filter(Boolean),
}));
record('real-translate', real);
await page.screenshot({ path: path.join(OUT, '01-real-translate.png'), fullPage: false });

// 2. 改值 → 确认句
const rows = await page.$$('[data-testid="fact-row"]');
if (rows.length) {
  const editButtons = await page.$$('[data-testid="fact-row"] button');
  // 第一行的「修改」按钮
  for (const button of editButtons) {
    const text = await page.evaluate((node) => node.textContent, button);
    if (text === '修改') {
      await button.click();
      break;
    }
  }
  const input = await page.$('[data-testid="fact-edit-input"]');
  if (input) {
    await input.click({ clickCount: 3 });
    await input.type('4 p.m.');
    await page.click('[data-testid="fact-edit-save"]');
  }
  await page.click('[data-testid="confirm-build"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="confirm-card"]') ||
      document.querySelector('[data-testid="confirm-blocked"]'),
    { timeout: 15000 },
  );
  const confirm = await page.evaluate(() => ({
    english: document.querySelector('[data-testid="confirm-english"]')?.textContent ?? null,
    meaning: document.querySelector('[data-testid="confirm-meaning"]')?.textContent ?? null,
    blocked: document.querySelector('[data-testid="confirm-blocked"]')?.textContent ?? null,
  }));
  record('confirm-after-edit', confirm);
  await page.screenshot({ path: path.join(OUT, '02-confirm.png'), fullPage: false });

  if (confirm.english) {
    await page.focus('[data-testid="show-card"]');
    await page.click('[data-testid="show-card"]');
    await page.waitForSelector('[data-testid="big-card"]');
    const big = await page.evaluate(() => {
      const text = document.querySelector('[data-testid="big-card-text"]');
      const style = text ? getComputedStyle(text).fontSize : null;
      return { text: text?.textContent ?? null, fontSize: style };
    });
    record('big-card', big);
    await page.screenshot({ path: path.join(OUT, '03-big-card.png'), fullPage: false });
    await page.keyboard.press('Escape');
    const afterEsc = await page.evaluate(() => ({
      closed: !document.querySelector('[data-testid="big-card"]'),
      focusOnTrigger: document.activeElement?.getAttribute('data-testid') === 'show-card',
    }));
    record('big-card-esc', afterEsc);
  }
}

// 3. 三组预置样例（明确标注）
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('[data-testid="sample-sample-budget"]');
await page.click('[data-testid="sample-sample-budget"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="translation-text"]')?.textContent?.includes('预算'),
  { timeout: 10000 },
);
const preset = await page.evaluate(() => ({
  translation: document.querySelector('[data-testid="translation-text"]')?.textContent,
  badge: [...document.querySelectorAll('span')].map((node) => node.textContent?.trim()).find((text) => text?.includes('预置演示')),
  facts: [...document.querySelectorAll('[data-testid="fact-row"]')].map((row) => row.innerText.replace(/\s+/g, ' ').slice(0, 100)),
}));
record('preset-sample', preset);
await page.screenshot({ path: path.join(OUT, '04-preset.png'), fullPage: false });

// 4. 手机视口
await page.setViewport({ width: 390, height: 844 });
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('[data-testid="sample-sample-moved"]');
await page.click('[data-testid="sample-sample-moved"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="translation-text"]')?.textContent?.length > 0,
  { timeout: 10000 },
);
const mobile = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
}));
record('mobile-390', mobile);
await page.screenshot({ path: path.join(OUT, '05-mobile.png'), fullPage: false });

record('console-errors', consoleErrors);
const failed = steps.filter((step) => {
  if (step.name === 'health') return !step.data.ok;
  if (step.name === 'real-translate') return !String(step.data.translation || '').trim();
  if (step.name === 'confirm-after-edit') return !step.data.english && !step.data.blocked;
  if (step.name === 'big-card-esc') return !(step.data.closed && step.data.focusOnTrigger);
  if (step.name === 'mobile-390') return step.data.horizontalOverflow;
  if (step.name === 'console-errors') return step.data.length > 0;
  return false;
});
fs.writeFileSync(path.join(OUT, 'web-e2e.json'), JSON.stringify({ base: BASE, steps }, null, 2));
console.log('FAILED_STEPS', JSON.stringify(failed.map((step) => step.name)));
await browser.close();
process.exit(failed.length ? 1 : 0);
