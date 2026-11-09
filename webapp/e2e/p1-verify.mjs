/**
 * P1 端到端验收（真 Chrome）：三主题 / 主导航 / 反馈闭环 / 无障碍。
 *
 * 断言的是「真的能用」：主题切换后内容不丢、文字对比度 ≥4.5:1、
 * 反馈真的拿到编号且重启后能查、失败时输入还在。跑之前先起 8899 服务。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8899';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.WEB_OUT || path.resolve(HERE, '../../docs/evidence-web');
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const steps = [];
const record = (name, data) => {
  steps.push({ name, data });
  console.log('---', name, JSON.stringify(data));
};
const expect = (name, cond, detail) => {
  if (cond) record(name, 'PASS');
  else {
    failures.push(name);
    record(name, `FAIL ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
};

/** React 受控组件必须用原生 setter 触发，直接改 .value 会被 value tracker 吞掉。 */
async function setReactValue(selector, value) {
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, selector, value);
}

/** 让「2 · 中文译文」区块渲染出来（原文、译文、反馈入口都在里面）。 */
async function translateOnce(text) {
  await page.click('[data-testid="nav-captions"]');
  await page.click('[data-testid="original-input"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('[data-testid="original-input"]', text, { delay: 0 });
  await page.click('[data-testid="translate"]');
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="translation-text"]')?.textContent ?? '').trim().length > 0,
    { timeout: 120000 },
  );
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none', '--lang=zh-CN'],
});
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 1200, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
});
page.on('pageerror', (error) => consoleErrors.push(String(error).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('[data-testid="main-nav"]');

/* ---- 主导航 ---- */
{
  const nav = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('[data-testid^="nav-"]')].map((b) => b.textContent?.trim()),
    captionsVisible: !document.querySelector('[data-testid="original-input"]')?.closest('[hidden]'),
    learnHidden: Boolean(document.querySelector('[data-testid="learn-page"]')?.closest('[hidden]')),
  }));
  expect('N1 主导航四项齐全', JSON.stringify(nav.buttons) === JSON.stringify(['字幕', '学习', '反馈', '设置']), nav.buttons);
  expect('N2 默认停在字幕页', nav.captionsVisible, nav);
  expect('N3 学习页默认隐藏且明确标未完成',
    nav.learnHidden && (await page.$eval('[data-testid="learn-page"]', (el) => el.textContent?.includes('未完成') ?? false)), nav);
}

/* 先跑一句真实翻译：原文/译文/反馈入口都在有字幕之后才渲染。 */
await translateOnce('The deposit is 300.');

/* ---- 主题：真实对比度 ---- */
async function contrastSample() {
  return page.evaluate(() => {
    const parse = (value) => {
      const m = String(value).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const lum = (rgb) => {
      const [r, g, b] = rgb.slice(0, 3).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const surface = document.querySelector('.surface');
    const bg = parse(getComputedStyle(surface).backgroundColor) ?? [0, 0, 0, 1];
    const samples = [
      ['主标题', 'h1'],
      ['状态行', '[data-testid="header-status"]'],
      ['原文', '[data-testid="original-text"]'],
      ['译文', '[data-testid="translation-text"]'],
    ];
    return samples.map(([label, selector]) => {
      const el = document.querySelector(selector);
      if (!el) return { label, ratio: 0, missing: true };
      const fg = parse(getComputedStyle(el).color);
      return { label, ratio: fg ? Number(ratio(fg, bg).toFixed(2)) : 0, fg, bg };
    });
  });
}

for (const [pref, expected] of [['light', 'light'], ['dark', 'dark'], ['warm', 'warm']]) {
  await page.click('[data-testid="nav-settings"]');
  await page.click(`[data-testid="theme-${pref}"]`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const theme = await page.evaluate(() => ({
    attr: document.body.dataset.theme,
    saved: localStorage.getItem('copilot.theme.v1'),
    active: document.querySelector('[data-testid="theme-active"]')?.textContent?.trim(),
  }));
  expect(`T-${pref} 主题生效并保存`, theme.attr === expected && theme.saved === pref, theme);
  const contrast = await contrastSample();
  expect(
    `T-${pref} 普通文字对比度全部 ≥4.5:1`,
    contrast.every((s) => s.ratio >= 4.5),
    contrast,
  );
  record(`T-${pref}-contrast`, contrast);
  await page.screenshot({ path: path.join(OUT, `p1-theme-${pref}.png`), fullPage: false });
}

/* ---- 切换主题不清空内容 ---- */
{
  await page.click('[data-testid="nav-captions"]');
  await page.click('[data-testid="original-input"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('[data-testid="original-input"]', 'The deposit is 300.', { delay: 0 });
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="theme-warm"]');
  await page.click('[data-testid="nav-captions"]');
  const kept = await page.$eval('[data-testid="original-input"]', (el) => el.value);
  expect('T4 切主题不清空当前输入', kept === 'The deposit is 300.', kept);
  // 刷新后主题保持（localStorage）
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="main-nav"]');
  const afterReload = await page.evaluate(() => document.body.dataset.theme);
  expect('T5 刷新后主题选择保持', afterReload === 'warm', afterReload);
}

/* ---- 跟随系统 ---- */
{
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="theme-system"]');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const dark = await page.evaluate(() => document.body.dataset.theme);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const light = await page.evaluate(() => document.body.dataset.theme);
  expect('T6 跟随系统随偏好切换', dark === 'dark' && light === 'light', { dark, light });
  await page.click('[data-testid="theme-dark"]');
  await page.click('[data-testid="nav-captions"]');
}

/* ---- 200% 放大 + 窄屏 ---- */
{
  await page.click('[data-testid="nav-captions"]');
  await page.setViewport({ width: 360, height: 900, deviceScaleFactor: 1 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const layout = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="translate"]');
    const rect = btn?.getBoundingClientRect();
    return {
      translateVisible: Boolean(rect && rect.width > 0 && rect.height > 0),
      navVisible: [...document.querySelectorAll('[data-testid^="nav-"]')].every((b) => b.getBoundingClientRect().width > 0),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect('A1 200% 放大 + 360px 窄屏下翻译按钮与导航仍可用',
    layout.translateVisible && layout.navVisible, layout);
  expect('A2 无严重横向溢出', layout.scrollWidth <= layout.innerWidth * 1.35, layout);
  await page.screenshot({ path: path.join(OUT, 'p1-narrow-200.png'), fullPage: false });
  await page.evaluate(() => { document.body.style.zoom = ''; });
  await page.setViewport({ width: 960, height: 1200, deviceScaleFactor: 1 });
}

/* ---- 反馈：从字幕入口带上下文 ---- */
{
  await translateOnce('The deposit is 300.');
  await page.click('[data-testid="feedback-from-caption"]');
  await page.waitForSelector('[data-testid="feedback-panel"]');
  const preview = await page.$eval('[data-testid="feedback-preview"]', (el) => el.textContent ?? '');
  expect('F1 字幕入口带上了原文供预览', preview.includes('The deposit is 300.'), preview.slice(0, 160));
  const attachDefault = await page.$eval('[data-testid="feedback-attach"]', (el) => el.checked);
  expect('F2 默认不附带上下文', attachDefault === false, attachDefault);
}

/* ---- 反馈：字数规则与空白拦截 ---- */
{
  const blankDisabled = await page.$eval('[data-testid="feedback-submit"]', (el) => el.disabled);
  expect('F3 空白时提交被禁用', blankDisabled === true, blankDisabled);
  await page.type('[data-testid="feedback-where"]', '译文自己补了币种', { delay: 0 });
  await page.type('[data-testid="feedback-suggest"]', '请显示币种未说明', { delay: 0 });
  const counter = await page.$eval('[data-testid="feedback-counter"]', (el) => el.textContent ?? '');
  const expected = [...'译文自己补了币种\n请显示币种未说明'].length;
  expect('F4 已输入字数与剩余字数正确',
    counter.includes(`已输入 ${expected}`) && counter.includes(`剩余 ${1000 - expected}`), counter);
  // 超限：前后端同一规则
  await setReactValue('[data-testid="feedback-where"]', '错'.repeat(1001));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const over = await page.evaluate(() => ({
    counter: document.querySelector('[data-testid="feedback-counter"]')?.textContent ?? '',
    disabled: document.querySelector('[data-testid="feedback-submit"]')?.disabled,
  }));
  expect('F5 超过 1000 字符被拦下', over.disabled === true && /超出/.test(over.counter), over);
  // 恢复成正常内容
  await setReactValue('[data-testid="feedback-where"]', '译文自己补了币种（第二条）');
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/* ---- 反馈：失败时保留输入 ---- */
{
  await page.setOfflineMode(true);
  await page.click('[data-testid="feedback-submit"]');
  await new Promise((resolve) => setTimeout(resolve, 900));
  const state = await page.evaluate(() => ({
    where: document.querySelector('[data-testid="feedback-where"]')?.value ?? '',
    suggest: document.querySelector('[data-testid="feedback-suggest"]')?.value ?? '',
    error: document.querySelector('[data-testid="feedback-error"]')?.textContent ?? '',
  }));
  expect('F6 断网提交失败后用户输入的字还在',
    state.where.includes('译文自己补了币种') && state.suggest.includes('请显示币种未说明'), state);
  expect('F7 失败有明确提示', state.error.length > 0, state.error);
  await page.setOfflineMode(false);
}

/* ---- 反馈：成功入库、状态如实、凭证查询 ---- */
{
  await page.click('[data-testid="feedback-submit"]');
  await page.waitForSelector('[data-testid="feedback-receipt"]', { timeout: 10000 }).catch(() => {});
  const receipt = await page.evaluate(() => ({
    ticket: document.querySelector('[data-testid="feedback-ticket"]')?.textContent?.trim() ?? '',
    token: document.querySelector('[data-testid="feedback-token"]')?.textContent?.trim() ?? '',
    text: document.querySelector('[data-testid="feedback-receipt"]')?.textContent ?? '',
  }));
  expect('F8 提交成功返回反馈编号', /^FB-\d{8}-[0-9A-F]{6}$/.test(receipt.ticket), receipt);
  expect('F9 状态是「已收到」，没有假显示「已修复」',
    receipt.text.includes('已收到') && !/状态\s*已修复/.test(receipt.text), receipt.text.slice(0, 180));
  expect('F10 返回一次性查询凭证', receipt.token.length >= 16, receipt.token);

  // 正确凭证查询
  await page.click('[data-testid="feedback-query-submit"]');
  await page.waitForSelector('[data-testid="feedback-query-result"]', { timeout: 10000 }).catch(() => {});
  const status = await page.$eval('[data-testid="feedback-query-status"]', (el) => el.textContent ?? '').catch(() => '');
  expect('F11 查询返回与提交一致的状态', status.includes('已收到'), status);

  // 错凭证：不显示反馈正文
  await setReactValue('[data-testid="feedback-query-token"]', 'definitely-wrong');
  await page.click('[data-testid="feedback-query-submit"]');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const denied = await page.evaluate(() => ({
    error: document.querySelector('[data-testid="feedback-query-error"]')?.textContent ?? '',
    hasResult: Boolean(document.querySelector('[data-testid="feedback-query-result"]')),
  }));
  expect('F12 凭证不对时不显示反馈内容', denied.error.length > 0 && !denied.hasResult, denied);

  record('F-receipt', { ticket: receipt.ticket, status: '已收到' });
  await page.screenshot({ path: path.join(OUT, 'p1-feedback.png'), fullPage: false });
  fs.writeFileSync(path.join(OUT, 'p1-feedback-receipt.json'), JSON.stringify({
    ticket: receipt.ticket,
    // 凭证不写进证据文件（它是一次性查询凭据）
    status: 'received',
  }, null, 2));
}

/*
 * F6 故意断网、F12 故意用错凭证，这两条必然产生网络错误日志。
 * 它们是**预期的失败路径**，不能算页面异常；其余错误才算。
 */
const expectedNetwork = /ERR_INTERNET_DISCONNECTED|403 \(Forbidden\)/;
const unexpectedErrors = consoleErrors.filter((line) => !expectedNetwork.test(line));
record('预期的失败路径日志', consoleErrors.filter((line) => expectedNetwork.test(line)));
expect('console 无意外错误', unexpectedErrors.length === 0, unexpectedErrors);

await browser.close();
fs.writeFileSync(
  path.join(OUT, 'p1-verify.json'),
  JSON.stringify({ base: BASE, steps, failures, consoleErrors }, null, 2),
);
console.log('\nFAILED_STEPS', JSON.stringify(failures));
process.exitCode = failures.length ? 1 : 0;
