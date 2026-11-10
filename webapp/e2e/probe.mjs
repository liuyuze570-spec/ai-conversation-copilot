/**
 * 无障碍修复的针对性验证（真 Chrome）。
 *
 * 只验这一轮改的四件事，跑得快，用来在改代码时反复自查：
 *  1. 数字译错时出现「关键信息对不上」警示；
 *  2. A− 同时缩原文和译文；
 *  3. 大字卡 / 隐私弹层打开时 Tab 不跑到背景，Esc 后焦点回入口；
 *  4. 事实行三个操作名称可区分。
 */
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8000';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none', '--lang=zh-CN'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1200 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('[data-testid="original-input"]');

/* 1. 真实翻译 + 一致性警示 ------------------------------------------------ */
await page.click('[data-testid="original-input"]');
await page.type(
  '[data-testid="original-input"]',
  'Please move the meeting to Friday at 2 p.m. The budget is twelve thousand, not twenty thousand.',
  { delay: 0 },
);
await page.click('[data-testid="translate"]');
await page.waitForFunction(
  () => document.querySelector('[data-testid="translation-text"]')?.textContent?.trim().length > 0,
  { timeout: 60000 },
);
const translation = await page.$eval('[data-testid="translation-text"]', (el) => el.textContent.trim());
console.log('  译文：', translation);

const warn = await page.evaluate(() => {
  const node = document.querySelector('[data-testid="numeric-warning"]');
  return node ? { role: node.getAttribute('role'), text: node.textContent.replace(/\s+/g, ' ').trim() } : null;
});

/*
 * 断言「警示是否出现」必须和「译文到底错没错」一致，不能写死成「必须有警示」。
 *
 * 实测同一份模型在两个环境给出不同译文：
 *   本机  → `预算为12 000,而不是2 000`（2 000 错，应有警示）
 *   公网  → `预算为12 000,而不是2万`（2万 = 20000，正确，不该有警示）
 * 这只差一个 onnxruntime/numpy 版本。所以这里在 Node 侧用同一套规则
 * 算一遍「应该怎样」，再和页面上的实际表现比对。
 */
const { checkNumericConsistency } = require('../../dist/shared/numeric-check.js');
const expectation = checkNumericConsistency(
  'Please move the meeting to Friday at 2 p.m. The budget is twelve thousand, not twenty thousand.',
  translation,
);
ok(
  '警示出现与否和译文对错一致',
  Boolean(warn) === (expectation.level === 'warn'),
  `规则判定 ${expectation.level}，页面${warn ? '有' : '无'}警示`,
);
if (warn) {
  ok('警示用 role=alert', warn.role === 'alert', `role=${warn.role}`);
  ok('警示列出对不上的值', /在原文中找不到|没有出现|对不上/.test(warn.text), warn.text.slice(0, 100));
}
// 不管译文对不对，事实卡上的「当前值」都必须在，且来源不能错配
const moneyRows = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid="fact-row"]'))
    .map((row) => row.textContent.replace(/\s+/g, ' ').trim())
    .filter((text) => text.includes('金额')),
);
ok(
  '金额卡同时有当前值和被否定值',
  moneyRows.length === 2,
  JSON.stringify(moneyRows.map((t) => t.slice(0, 46))),
);
ok(
  '金额卡没有把两万配给 twelve thousand',
  !moneyRows.some((t) => t.includes('2万') && t.includes('twelve thousand')),
  JSON.stringify(moneyRows.map((t) => t.slice(0, 46))),
);

/* 2. A−/A+ 全局缩放原文、译文与回复卡英文 --------------------------------- */
// 字号按钮在「设置」页，先切过去。
await page.click('[data-testid="nav-settings"]');
await page.waitForSelector('[data-testid="font-larger"]', { timeout: 5000 });
const readFonts = () =>
  page.evaluate(() => ({
    original: parseFloat(getComputedStyle(document.querySelector('[data-testid="original-text"]')).fontSize),
    translation: parseFloat(getComputedStyle(document.querySelector('[data-testid="translation-text"]')).fontSize),
    bodyScale: document.body.getAttribute('data-font-scale'),
  }));
const before = await readFonts();
await page.click('[data-testid="font-smaller"]');
const afterMinus = await readFonts();
await page.click('[data-testid="font-larger"]');
await page.click('[data-testid="font-larger"]');
const afterPlus = await readFonts();
ok(
  'A− 全局缩小两处',
  afterMinus.original < before.original && afterMinus.translation < before.translation,
  `原文 ${before.original}→${afterMinus.original}，译文 ${before.translation}→${afterMinus.translation}`,
);
ok(
  'A+ 全局放大两处',
  afterPlus.original > afterMinus.original && afterPlus.translation > afterMinus.translation,
  `原文 ${afterMinus.original}→${afterPlus.original}，译文 ${afterMinus.translation}→${afterPlus.translation}`,
);
ok(
  '缩放档位写进 body[data-font-scale]',
  afterPlus.bodyScale !== '1' && afterPlus.bodyScale !== null,
  `data-font-scale=${afterPlus.bodyScale}`,
);
// 回到字幕页，后续测试（事实行/确认卡）都在字幕页。
await page.click('[data-testid="nav-captions"]');

/* 3. 事实行名称可区分 ---------------------------------------------------- */
const factNames = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid="fact-check"]')).map((el) => ({
    label: el.getAttribute('aria-label'),
    describedBy: el.getAttribute('aria-describedby'),
    describedText: el.getAttribute('aria-describedby')
      ? document.getElementById(el.getAttribute('aria-describedby'))?.textContent?.trim().slice(0, 40)
      : null,
  })),
);
const editNames = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid="fact-edit"]')).map((el) => el.getAttribute('aria-label')),
);
const uniqueChecks = new Set(factNames.map((f) => f.label)).size === factNames.length;
const uniqueEdits = new Set(editNames).size === editNames.length;
ok('核对名称互不相同', uniqueChecks && factNames.length > 1, JSON.stringify(factNames.map((f) => f.label)));
ok('修改名称互不相同', uniqueEdits && editNames.length > 1, JSON.stringify(editNames));
ok(
  '核对名称关联来源句',
  factNames.every((f) => f.describedBy && f.describedText),
  JSON.stringify(factNames.map((f) => f.describedText)),
);

/* 4. 生成确认 → 大字卡焦点 ------------------------------------------------ */
await page.click('[data-testid="confirm-build"]');
await page.waitForSelector('[data-testid="confirm-card"]', { timeout: 15000 });
const plan = await page.evaluate(() => ({
  english: document.querySelector('[data-testid="confirm-english"]')?.textContent.trim(),
  meaning: document.querySelector('[data-testid="confirm-meaning"]')?.textContent.trim(),
}));
console.log('  确认句：', JSON.stringify(plan));
ok('中文释义不含英文时间', plan.meaning && !/p\.?m\.?|a\.?m\.?|Monday|Tuesday|Friday/i.test(plan.meaning), plan.meaning);
ok('英文确认句保留英文时间', Boolean(plan.english && /p\.?m\.?|a\.?m\.?/i.test(plan.english)), plan.english);

// 打开大字卡
const cardOpener = await page.$('[data-testid="show-card"]');
await cardOpener.click();
await page.waitForSelector('[data-testid="big-card"]', { timeout: 5000 });

// 连按 Tab，看焦点是否留在 dialog 内
const tabTrace = [];
for (let i = 0; i < 6; i += 1) {
  await page.keyboard.press('Tab');
  tabTrace.push(
    await page.evaluate(() => {
      const active = document.activeElement;
      const dialog = document.querySelector('[data-testid="big-card"]')?.closest('[role="dialog"]');
      return {
        tag: active?.tagName,
        text: (active?.textContent ?? '').trim().slice(0, 14),
        inDialog: Boolean(dialog && active && dialog.contains(active)),
      };
    }),
  );
}
ok('大字卡 Tab 不跑到背景', tabTrace.every((t) => t.inDialog), JSON.stringify(tabTrace.map((t) => t.text)));
const shellInert = await page.evaluate(() => document.querySelector('[data-app-shell]')?.hasAttribute('inert'));
ok('大字卡打开时背景 inert', shellInert === true, `inert=${shellInert}`);

// Shift+Tab 反向也要留在里面
const shiftTrace = [];
for (let i = 0; i < 4; i += 1) {
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');
  shiftTrace.push(
    await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="big-card"]')?.closest('[role="dialog"]');
      return Boolean(dialog && dialog.contains(document.activeElement));
    }),
  );
}
ok('大字卡 Shift+Tab 不跑到背景', shiftTrace.every(Boolean), JSON.stringify(shiftTrace));

await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('[data-testid="big-card"]'), { timeout: 4000 });
const focusAfterCard = await page.evaluate(() => ({
  testid: document.activeElement?.getAttribute('data-testid'),
  inert: document.querySelector('[data-app-shell]')?.hasAttribute('inert'),
}));
ok('大字卡 Esc 关闭并回触发按钮', focusAfterCard.testid === 'show-card', JSON.stringify(focusAfterCard));
ok('关闭后背景解除 inert', focusAfterCard.inert === false);

/* 5. 隐私弹层焦点 -------------------------------------------------------- */
await page.click('button[aria-label="隐私与数据"], button::-p-text(隐私与数据)').catch(async () => {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '隐私与数据');
    btn?.click();
  });
});
await page.waitForSelector('#privacy-title', { timeout: 5000 });
const privacyTrace = [];
for (let i = 0; i < 8; i += 1) {
  await page.keyboard.press('Tab');
  privacyTrace.push(
    await page.evaluate(() => {
      const dialog = document.querySelector('#privacy-title')?.closest('[role="dialog"]');
      return {
        text: (document.activeElement?.textContent ?? '').trim().slice(0, 12),
        inDialog: Boolean(dialog && dialog.contains(document.activeElement)),
      };
    }),
  );
}
ok('隐私弹层 Tab 不跑到背景', privacyTrace.every((t) => t.inDialog), JSON.stringify(privacyTrace.map((t) => t.text)));
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('#privacy-title'), { timeout: 4000 });
const focusAfterPrivacy = await page.evaluate(() => {
  const active = document.activeElement;
  return { text: (active?.textContent ?? '').trim().slice(0, 12) };
});
ok('隐私 Esc 后焦点回「隐私与数据」', focusAfterPrivacy.text === '隐私与数据', JSON.stringify(focusAfterPrivacy));

/* 6. 页面横向不溢出（390px） --------------------------------------------- */
await page.setViewport({ width: 390, height: 900 });
await new Promise((r) => setTimeout(r, 300));
const overflow = await page.evaluate(() => ({
  doc: document.documentElement.scrollWidth,
  win: window.innerWidth,
}));
ok('390px 无横向溢出', overflow.doc <= overflow.win + 1, JSON.stringify(overflow));

/* 7. 320px（最窄的常见手机） ---------------------------------------------- */
await page.setViewport({ width: 320, height: 800 });
await new Promise((r) => setTimeout(r, 300));
const narrow = await page.evaluate(() => {
  const btn = document.querySelector('[data-testid="translate"]');
  const rect = btn?.getBoundingClientRect();
  return {
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    translateRight: rect ? Math.round(rect.right) : null,
  };
});
ok(
  '320px 无横向溢出且主按钮在屏内',
  narrow.doc <= narrow.win + 1 && (narrow.translateRight ?? 0) <= narrow.win + 1,
  JSON.stringify(narrow),
);

/* 8. 200% 缩放（450px 视口 ≈ 900px 窗口放大到 200%） --------------------- */
await page.setViewport({ width: 450, height: 700 });
await new Promise((r) => setTimeout(r, 300));
const zoomed = await page.evaluate(() => {
  const input = document.querySelector('[data-testid="original-input"]');
  const rect = input?.getBoundingClientRect();
  return {
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    inputRight: rect ? Math.round(rect.right) : null,
    inputWidth: rect ? Math.round(rect.width) : null,
  };
});
ok(
  '200% 缩放不横向溢出，输入框仍可用',
  zoomed.doc <= zoomed.win + 1 && (zoomed.inputRight ?? 0) <= zoomed.win + 1 && (zoomed.inputWidth ?? 0) > 120,
  JSON.stringify(zoomed),
);
await page.setViewport({ width: 900, height: 1200 });
await new Promise((r) => setTimeout(r, 200));

/* 9. 高对比（真换底色，不只是加个边框） ---------------------------------- */
const hcBefore = await page.evaluate(() => ({
  bg: getComputedStyle(document.body).backgroundColor,
  pressed: document.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed'),
}));
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '高对比');
  btn?.click();
});
await new Promise((r) => setTimeout(r, 200));
const hcAfter = await page.evaluate(() => ({
  bg: getComputedStyle(document.body).backgroundColor,
  pressed: Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent.trim() === '高对比')
    ?.getAttribute('aria-pressed'),
  hcClass: document.body.classList.contains('hc'),
}));
ok(
  '高对比真的换底色',
  hcAfter.bg !== hcBefore.bg && hcAfter.hcClass === true,
  JSON.stringify({ before: hcBefore.bg, after: hcAfter.bg, pressed: hcAfter.pressed }),
);
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '高对比');
  btn?.click();
});

/* 10. 字号边界：连点 A+ / A−，缩放档位锁定在 0.85–1.6 -------------------- */
await page.click('[data-testid="nav-settings"]');
await page.waitForSelector('[data-testid="font-larger"]', { timeout: 5000 });
const plus = '[data-testid="font-larger"]';
const minus = '[data-testid="font-smaller"]';
for (let i = 0; i < 20; i += 1) await page.click(plus);
const maxScale = await page.evaluate(() => document.body.getAttribute('data-font-scale'));
for (let i = 0; i < 30; i += 1) await page.click(minus);
const minScale = await page.evaluate(() => document.body.getAttribute('data-font-scale'));
ok('缩放上限不越界（≤1.6）', parseFloat(maxScale) <= 1.6, `max=${maxScale}`);
ok('缩放下限不越界（≥0.85）', parseFloat(minScale) >= 0.85, `min=${minScale}`);
// 回到默认档，避免影响后面的截图
for (let i = 0; i < 8; i += 1) await page.click(plus);

ok('控制台无错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)));

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
if (failed.length) {
  for (const f of failed) console.log('  ✗', f.name, f.detail ?? '');
  process.exit(1);
}
