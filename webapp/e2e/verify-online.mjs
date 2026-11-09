/**
 * 线上真机验收：日常问候 / 谐音 / 日韩俄 / 自动回复。
 *
 * 只打**已发布的公网地址**，不看本地服务 —— 本地跑通不等于线上跑通。
 * 每一步都断言「屏幕上真出现了什么」，而不是「请求返回了什么」。
 *
 * 跑法：node webapp/e2e/verify-online.mjs
 * 产物：docs/evidence-web/online-*.png 与本进程打印的 PASS/FAIL 行。
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.WEB_BASE
  || 'https://en-zh-caption-helper.app.workbuddy.host/?sharecode=X3A6YY6GQH';
const OUT = 'docs/evidence-web';
mkdirSync(OUT, { recursive: true });

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL ${label}${detail ? `  → ${detail}` : ''}`);
    console.log(`     [page] error=${globalThis.__lastR?.errorText ?? '?'} retry=${globalThis.__lastR?.hasRetry ?? '?'}`);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none', '--lang=zh-CN'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 1280 });
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60000 });

async function translate(text, lang) {
  if (lang) {
    await page.click(`[data-testid="source-language-${lang}"]`);
    await new Promise((r) => setTimeout(r, 300));
  }
  await page.click('[data-testid="original-input"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('[data-testid="original-input"]', text);
  await page.click('[data-testid="translate"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="translation-text"]');
      const err = document.querySelector('[data-testid="retry-last"]');
      return (el && el.textContent.trim().length > 0) || Boolean(err);
    },
    { timeout: 60000 },
  );
  await new Promise((r) => setTimeout(r, 1200));
  return page.evaluate(() => ({
    errorText: document.querySelector('[data-testid="session-failed"]')?.textContent?.trim() ?? '',
    hasRetry: Boolean(document.querySelector('[data-testid="retry-last"]')),
    translation: document.querySelector('[data-testid="translation-text"]')?.textContent?.trim() ?? '',
    original: document.querySelector('[data-testid="original-text"]')?.textContent?.trim() ?? '',
    hint: document.querySelector('[data-testid="original-text"]')
      ? document.body.innerText.match(/汉字近音[^\n]*/)?.[0] ?? ''
      : '',
    corrected: Boolean(document.querySelector('[data-testid="corrected-hint"]')),
    wordGloss: Boolean(document.querySelector('[data-testid="word-gloss-hint"]')),
    cascade: Boolean(document.querySelector('[data-testid="cascade-hint"]')),
    // 0.7.0-web.7 起回复区换成回复卡（reply-en-N），旧选择器 reply-text-N 不存在了
    replies: Array.from(
      document.querySelectorAll('[data-testid^="reply-en-"], [data-testid^="reply-text-"]'),
    ).map(
      (n) => n.textContent.trim(),
    ),
  }));
}

// 1. 用户报的那个 bug：hellow
let r = await (globalThis.__lastR = await translate)('hellow');
check('hellow 译文是「你好」而不是「地狱」', r.translation === '你好', r.translation);
check('hellow 读音是「哈喽」', r.hint.includes('哈喽'), r.hint);
check('hellow 标了「常见手误」并点名 hello', r.corrected, '没有 corrected-hint');
await page.screenshot({ path: `${OUT}/online-hellow.png` });

// 2. 日常问候
r = await (globalThis.__lastR = await translate)('Good morning');
check('Good morning → 早上好', r.translation === '早上好', r.translation);
r = await (globalThis.__lastR = await translate)('Thank you so much.');
check('Thank you so much. → 太感谢你了', r.translation.includes('感谢'), r.translation);

// 3. 专业用语
r = await (globalThis.__lastR = await translate)('Please send me the invoice.');
check('invoice 句 → 请把发票发给我', r.translation.includes('发票'), r.translation);

// 4. 看视频口语
r = await (globalThis.__lastR = await translate)('Are you kidding me?');
check('Are you kidding me? → 你在开玩笑吗', r.translation.includes('开玩笑'), r.translation);

// 5. 四六级/学习场景
r = await (globalThis.__lastR = await translate)('I am preparing for the exam.');
check('prepare for the exam 句正确', r.translation.includes('考试'), r.translation);

// 6. 自动回复：翻译完成后应自动出现候选
check('翻译后自动出现 3 条回复建议', r.replies.length === 3, `实际 ${r.replies.length} 条`);
check('第一条回复不是「Yes, that works for me」这类替人答应的话',
  r.replies.every((line) => !/^yes,? that works/i.test(line)), r.replies.join(' | '));

// 7. 日语
r = await (globalThis.__lastR = await translate)('明日の会議は何時ですか', 'ja');
check('日语整句出中文', /会议|几点/.test(r.translation), r.translation);
check('日语标了「经英语转译」', r.cascade, '没有 cascade-hint');
check('日语原文读音有汉字近音', r.hint.length > 6, r.hint);
await page.screenshot({ path: `${OUT}/online-ja.png` });

// 8. 韩语 / 俄语问候
r = await (globalThis.__lastR = await translate)('안녕하세요', 'ko');
check('韩语问候 → 你好', r.translation === '你好', r.translation);
check('韩语读音是「安宁哈塞哟」', r.hint.includes('安宁'), r.hint);
r = await (globalThis.__lastR = await translate)('Здравствуйте', 'ru');
check('俄语问候 → 您好', r.translation.includes('您好'), r.translation);
check('俄语读音是「兹德拉斯特维杰」', r.hint.includes('兹德拉'), r.hint);
await page.screenshot({ path: `${OUT}/online-ru.png` });

// 9. 未就绪语种不能点（这里三个都就绪，验的是「按钮存在且可点」）
const langButtons = await page.$$eval(
  '[data-testid^="source-language-"]:not([data-testid="source-language-group"])',
  (nodes) => nodes.map((n) => ({ text: n.textContent.trim(), disabled: n.disabled })),
);
check('四个语种按钮都在，且都可用', langButtons.length === 4 && langButtons.every((b) => !b.disabled),
  JSON.stringify(langButtons));

check('页面无 JS 异常', jsErrors.length === 0, jsErrors.join(' | '));

await browser.close();
console.log(`\nRESULT ${failures.length ? 'FAIL' : 'PASS'} ${passed}/${passed + failures.length}`);
if (failures.length) process.exit(1);
