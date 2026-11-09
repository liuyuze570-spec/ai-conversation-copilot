/**
 * P0/P1 端到端验收（真 Chrome）：金额币种 / 改期 / 否定 / 回复卡。
 *
 * 三句来自用户 2026-11-09 的报告（测试 A / B / C），断言的不是「有输出」，
 * 是「保真」：译文不补币种、改期能听出来、否定不当数、回复卡有用途 +
 * 英文 + 中文 + 分段近音。跑之前先把本地 8899 服务起起来（部署目录副本）。
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
  if (cond) {
    record(name, 'PASS');
  } else {
    failures.push(name);
    record(name, `FAIL ${detail ?? ''}`);
  }
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none', '--lang=zh-CN'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
});
page.on('pageerror', (error) => consoleErrors.push(String(error).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForSelector('[data-testid="original-input"]');

async function runSentence(tag, sentence) {
  await page.click('[data-testid="original-input"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('[data-testid="original-input"]', sentence, { delay: 0 });
  await page.click('[data-testid="translate"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="translation-text"]')?.textContent?.trim().length > 0,
    { timeout: 120000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  return page.evaluate(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? '';
    const factRows = [...document.querySelectorAll('[data-testid="fact-row"]')].map((row) => ({
      text: row.textContent?.trim() ?? '',
    }));
    const corrections = [...document.querySelectorAll('[data-testid="translate-corrections"] li')].map(
      (li) => li.textContent?.trim() ?? '',
    );
    const replyCards = [...document.querySelectorAll('[data-testid^="reply-card-"]')].map((card) => ({
      purpose: text(`[data-testid="reply-purpose-${card.getAttribute('data-testid').split('-').pop()}"]`),
      en: text(`[data-testid="reply-en-${card.getAttribute('data-testid').split('-').pop()}"]`),
      zh: text(`[data-testid="reply-zh-${card.getAttribute('data-testid').split('-').pop()}"]`),
      phon: text(`[data-testid="reply-phon-${card.getAttribute('data-testid').split('-').pop()}"]`),
    }));
    return {
      translation: text('[data-testid="translation-text"]'),
      factRows,
      corrections,
      replyCards,
      replySource: text('[data-testid="reply-source"]'),
      phonToggle: Boolean(document.querySelector('[data-testid="phon-toggle"]')),
    };
  });
}

/* ---- 测试 A：金额 / 币种 ---- */
{
  const r = await runSentence('A', 'The deposit is 300 and the remaining balance is 900.');
  record('A-translation', r.translation);
  expect('A1 译文不补币种', !/美元|美金|人民币/.test(r.translation), r.translation);
  expect('A2 修正提示出现', r.corrections.length >= 1, r.corrections);
  const factText = r.factRows.map((f) => f.text).join('\n');
  expect('A3 事实卡标「币种未说明」', /币种未说明/.test(factText), factText);
  expect('A4 事实卡引原话数字', /原话：\s*300/.test(factText) && /原话：\s*900/.test(factText), factText);
  expect('A5 不把「300美元」标成原话', !/原话：\s*300美元/.test(factText), factText);
  const first = r.replyCards[0];
  expect('A6 回复卡≥3 张', r.replyCards.length >= 3, r.replyCards.length);
  expect(
    'A7 首卡确认金额并问币种',
    Boolean(first && /deposit is 300/i.test(first.en) && /[Ww]hat currency/i.test(first.en)),
    first?.en,
  );
  expect('A8 回复卡有中文意思', Boolean(first?.zh && first.zh.length > 3), first?.zh);
  // 近音默认隐藏（这是设计：显示/隐藏开关），点开再验内容。
  await page.click('[data-testid="phon-toggle"]');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const phonTexts = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid^="reply-card-"]')];
    return cards.map((card) => {
      const index = card.getAttribute('data-testid').split('-').pop();
      return document.querySelector(`[data-testid="reply-phon-${index}"]`)?.textContent?.trim() ?? '';
    });
  });
  expect(
    'A9 分段近音（开关打开后）有内容且分了段',
    phonTexts.length >= 3 && phonTexts.every((t) => t.length > 5),
    phonTexts,
  );
  expect('A10 近音开关存在', r.phonToggle);
  await page.screenshot({ path: path.join(OUT, 'p0-A.png'), fullPage: false });
}

/* ---- 测试 B：改期 ---- */
{
  const r = await runSentence('B', 'The rehearsal has moved from Wednesday morning to Friday afternoon. It will still last ninety minutes.');
  record('B-translation', r.translation);
  expect('B1 译文能听出「改到」', /改到|改为|变更/.test(r.translation), r.translation);
  const factText = r.factRows.map((f) => f.text).join('\n');
  expect('B2 周五不与周三平起平坐（原安排有标记）', /原安排|原先|旧/.test(factText), factText);
  expect('B3 时长单独成卡', /90\s*分钟|九十分钟|ninety/i.test(factText), factText);
  const first = r.replyCards[0];
  expect(
    'B4 首卡表达变更关系',
    Boolean(first && /instead of Wednesday morning/i.test(first.en) && /ninety minutes/i.test(first.en)),
    first?.en,
  );
  await page.screenshot({ path: path.join(OUT, 'p0-B.png'), fullPage: false });
}

/* ---- 测试 C：否定 ---- */
{
  const r = await runSentence('C', 'The appointment is at 4:20 p.m. on Wednesday, not Thursday.');
  record('C-translation', r.translation);
  const factText = r.factRows.map((f) => f.text).join('\n');
  expect('C1 周四标为不作数', /不作数|被对方否定/.test(factText), factText);
  expect('C2 周三是有效安排', /星期三|周三/.test(factText), factText);
  const cards = r.replyCards.map((c) => c.en).join(' | ');
  expect('C3 回复卡不把周四当有效日期', !/Thursday,|, Thursday\b|on Thursday/.test(cards) || /not Thursday/.test(cards), cards);
  expect('C4 回复卡有「不是周四」类确认', /not Thursday/i.test(cards), cards);
  await page.screenshot({ path: path.join(OUT, 'p0-C.png'), fullPage: false });
}

/* ---- 回复卡操作：放大展示 ---- */
{
  await page.click('[data-testid="reply-big-0"]');
  await page.waitForSelector('[data-testid="card-sentence"], [data-testid="big-card"]', { timeout: 5000 }).catch(() => {});
  const bigVisible = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="card-sentence"], [data-testid="big-card"]');
    return el ? el.textContent?.trim().slice(0, 60) : null;
  });
  expect('R1 放大卡能打开且回复句在里面', Boolean(bigVisible), bigVisible);
  record('R1-bigcard', bigVisible);
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.screenshot({ path: path.join(OUT, 'p0-R.png'), fullPage: false });
}

expect('console 无错误', consoleErrors.length === 0, consoleErrors);

await browser.close();

fs.writeFileSync(
  path.join(OUT, 'p0-verify.json'),
  JSON.stringify({ base: BASE, steps, failures, consoleErrors }, null, 2),
);
console.log('\nFAILED_STEPS', JSON.stringify(failures));
process.exitCode = failures.length ? 1 : 0;
