/**
 * 离线便携版的界面取证：打开页面 → 真翻译 → 看徽标 → 截图。
 *
 * 用途不是「再测一遍功能」，而是留一张能对着看的图：界面确实标着
 * 「本地翻译模型（真实翻译）」，而不是「预置演示」。
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../../docs/evidence-offline');
const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8765';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--lang=zh-CN'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 1 });
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('[data-testid="original-input"]');

await page.click('[data-testid="original-input"]');
await page.type(
  '[data-testid="original-input"]',
  'The budget is twelve thousand, not twenty thousand.',
);
await page.click('[data-testid="translate"]');
await page.waitForFunction(
  () => (document.querySelector('[data-testid="translation-text"]')?.textContent ?? '').length > 4,
  { timeout: 60000 },
);

const info = await page.evaluate(() => ({
  translation: document.querySelector('[data-testid="translation-text"]')?.textContent,
  badges: Array.from(document.querySelectorAll('span'))
    .map((s) => s.textContent.trim())
    .filter((t) => t.includes('模型') || t.includes('预置') || t.includes('识别')),
  facts: Array.from(document.querySelectorAll('[data-testid="fact-row"]')).map((r) =>
    r.textContent.trim().slice(0, 60),
  ),
  warning: document.querySelector('[data-testid="numeric-warning"]')?.textContent?.slice(0, 120) ?? null,
}));

await page.screenshot({ path: path.join(OUT, 'offline-ui.png'), fullPage: false });
console.log(JSON.stringify(info, null, 1));
await browser.close();
