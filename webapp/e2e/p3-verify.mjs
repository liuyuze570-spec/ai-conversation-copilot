/**
 * 0.7.0-web.10 真 Chrome 验收（用户现场反馈的两处）。
 *
 *  A. 回复卡不再固定三句：影视对白 / 道谢 / 金额 三种输入产生不同回复；
 *     真 AI 未配置的说明必须显示，不许冒充模型生成。
 *  B. 双轨：① 逐句轨不变；② 整段轨在暂停/停止时自动按全部内容翻译；
 *     继续采集不用重新授权、整段译文标过期、手动刷新、停止释放全部轨道。
 *
 * 音频仍是 Windows SAPI 合成语音（非真人录音、非视频原声），
 * 真人点选视频标签页那一步脚本代替不了，文档单列未自动化验证。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8903';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.WEB_OUT || path.resolve(HERE, '../../docs/evidence-web');
const WAV_DIR = path.resolve(HERE, '../server/testdata');
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = () => page.evaluate(() => window.__COPILOT_TAB_AUDIO_TEST__?.snapshot() ?? null);

const firstWavs = ['s1-report.wav', 's4-new.wav'];
const laterWavs = ['s2-meeting.wav'];
const b64 = (name) => fs.readFileSync(path.join(WAV_DIR, name)).toString('base64');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none', '--lang=zh-CN',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.setDefaultTimeout(120000);
await page.setViewport({ width: 1000, height: 1300, deviceScaleFactor: 1 });
const consoleErrors = [];
const apiCalls = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
});
page.on('pageerror', (error) => consoleErrors.push(String(error).slice(0, 200)));
page.on('request', (req) => {
  if (req.url().includes('/api/')) apiCalls.push({ method: req.method(), url: req.url() });
});

async function translateOnce(text) {
  await page.click('[data-testid="nav-captions"]');
  await page.click('[data-testid="original-input"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('[data-testid="original-input"]', text, { delay: 0 });
  /*
   * 只等「译文非空」会读到上一句还留在 DOM 里的旧回复卡：点击返回时 React
   * 清空状态是异步的，旧节点可能仍在。2026-11-09 线上首跑 A7–A10 四项就是这样
   * 误报的（本地 8903 没触发，是时序差异）。改为等真实响应 + 译文确实换成新值。
   */
  const previous = await page.$eval(
    '[data-testid="translation-text"]',
    (el) => el.textContent.trim(),
  ).catch(() => '');
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/translate') && res.request().method() === 'POST',
      { timeout: 120000 },
    ),
    page.click('[data-testid="translate"]'),
  ]);
  await page.waitForFunction(
    (prev) => {
      const current = (document.querySelector('[data-testid="translation-text"]')?.textContent ?? '').trim();
      return current.length > 0 && current !== prev;
    },
    { timeout: 120000 },
    previous,
  );
  await page.waitForSelector('[data-testid^="reply-en-"]', { timeout: 120000 });
  return page.$$eval('[data-testid^="reply-en-"]', (els) => els.map((el) => el.textContent.trim()));
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="original-input"]');

  /* ---- 1. 版本 -------------------------------------------------------- */
  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  expect('V1 版本 0.7.0-web.10', health.version === '0.7.0-web.10', health.version);
  expect('V2 真实识别后端仍在', health.real.transcribe === true, health.mode);

  /* ---- 2. 回复卡按内容变，不再固定三句 -------------------------------- */
  const oldThree = [
    'Sorry, could you say that again a little slower?',
    "Thank you, I've got it.",
    'Sorry, could you type that instead? It is easier for me.',
  ];
  const movie = await translateOnce("This definitely the biggest movie that I've ever done.");
  record('MOVIE_REPLIES', movie);
  expect('A1 影视句给满三张', movie.length === 3, movie);
  expect('A2 影视句不再是旧的三句固定回复', movie.join('|') !== oldThree.join('|'), movie);
  expect('A3 影视句第一张贴合最高级内容', /impressive|biggest/i.test(movie[0]), movie[0]);
  expect('A4 前两张都不是旧兜底句',
    !oldThree.includes(movie[0]) && !oldThree.includes(movie[1]), movie);
  expect('A5 第三张仍保留「请求重复/打字」',
    /say that again|type that instead/i.test(movie[2]), movie[2]);
  expect('A6 英文回复不夹中文',
    movie.every((text) => !/[\u3400-\u9fff]/.test(text)), movie);

  const thanks = await translateOnce('Thank you so much for your help.');
  record('THANKS_REPLIES', thanks);
  expect('A7 道谢句与影视句回复不同', thanks.join('|') !== movie.join('|'), thanks);
  expect('A8 道谢句给出「不客气」', /welcome|No problem/i.test(thanks[0]), thanks[0]);

  const money = await translateOnce('The deposit is 300 and the remaining balance is 900.');
  record('MONEY_REPLIES', money);
  expect('A9 金额句仍问币种（P0 不倒退）', /What currency/.test(money[0]), money[0]);
  expect('A10 金额句回复仍保留两个数字', /300/.test(money[0]) && /900/.test(money[0]), money[0]);

  const sourceNote = await page.$eval('[data-testid="reply-source"]', (el) => el.textContent.trim());
  expect('A11 来源标注不冒充 AI', /本地规则|不是模型/.test(sourceNote), sourceNote);
  const hint = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="reply-model-hint"]');
    return { exists: Boolean(el), text: el?.textContent ?? '' };
  });
  expect('A12 界面写明真 AI 未配置及开启方式',
    hint.exists && hint.text.includes('未配置') && hint.text.includes('不是 AI') &&
    hint.text.includes('COPILOT_LLM_'), hint);

  /* ---- 3. 双轨界面 ---------------------------------------------------- */
  const ui = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="tab-audio-start"]')?.closest('section');
    return {
      hasPassage: Boolean(document.querySelector('[data-testid="tab-audio-passage"]')),
      hasLines: Boolean(document.querySelector('[data-testid="tab-audio-lines"]')),
      hasPause: Boolean(document.querySelector('[data-testid="tab-audio-pause"]')),
      hasResume: Boolean(document.querySelector('[data-testid="tab-audio-resume"]')),
      pauseDisabled: document.querySelector('[data-testid="tab-audio-pause"]')?.disabled,
      resumeDisabled: document.querySelector('[data-testid="tab-audio-resume"]')?.disabled,
      hasDualTrackText: (panel?.textContent ?? '').includes('两条轨道'),
      hasStopAutoText: (panel?.textContent ?? '').includes('停止并释放」会自动'),
    };
  });
  expect('B1 两条轨道都在', ui.hasPassage && ui.hasLines, ui);
  expect('B2 暂停/继续按钮都在且初始禁用', ui.hasPause && ui.hasResume &&
    ui.pauseDisabled === true && ui.resumeDisabled === true, ui);
  expect('B3 说明写清双轨与停止自动翻译', ui.hasDualTrackText && ui.hasStopAutoText, ui);

  /* ---- 4. 注入真实音频，等逐句字幕 ------------------------------------ */
  // 前面三次主界面翻译各自会调 /api/reply（那是主流程，不是 P2 片段）。
  // 从这里起只看采集期间有没有新的回复请求。
  apiCalls.length = 0;
  const injected = await page.evaluate(async ({ first, later }) => {
    const decode = async (encoded) => {
      const bin = atob(encoded);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return window.__P3_CTX__.decodeAudioData(bytes.buffer);
    };
    const ctx = new AudioContext();
    window.__P3_CTX__ = ctx;
    await ctx.resume();
    const buffers = [];
    for (const item of first) buffers.push(await decode(item));
    const total = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const merged = ctx.createBuffer(1, total, ctx.sampleRate);
    let offset = 0;
    for (const buffer of buffers) {
      merged.copyToChannel(buffer.getChannelData(0), 0, offset);
      offset += buffer.length;
    }
    const destination = ctx.createMediaStreamDestination();
    window.__P3_DEST__ = destination;
    const source = ctx.createBufferSource();
    source.buffer = merged;
    source.connect(destination);
    window.__P3_LATER__ = await decode(later[0]);
    source.start();
    await window.__COPILOT_TAB_AUDIO_TEST__.inject(destination.stream);
    return {
      audioTracks: destination.stream.getAudioTracks().length,
      seconds: Math.round((total / ctx.sampleRate) * 100) / 100,
    };
  }, { first: firstWavs.map(b64), later: laterWavs.map(b64) });
  record('INJECT', injected);
  expect('B4 注入真实音频轨', injected.audioTracks === 1, injected);

  await page.waitForFunction(
    () => (window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().lines.length ?? 0) >= 2,
    { timeout: 120000, polling: 400 },
  );
  const beforePause = await snapshot();
  record('BEFORE_PAUSE', {
    lines: beforePause.lines.map((l) => l.text), transcript: beforePause.transcript.length,
  });
  expect('B5 逐句轨已有真实字幕', beforePause.lines.length >= 2 &&
    beforePause.lines.every((l) => l.text.trim().length > 0), beforePause.lines.length);
  expect('B6 累积全文不为空', beforePause.transcript.length >= 2, beforePause.transcript.length);

  /* ---- 5. 暂停 → 自动整段翻译 ---------------------------------------- */
  await page.click('[data-testid="tab-audio-pause"]');
  await page.waitForFunction(
    () => window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().passage.status === 'done',
    { timeout: 120000, polling: 400 },
  );
  const paused = await snapshot();
  record('PAUSED', {
    state: paused.state, passage: paused.passage, lines: paused.lines.length,
  });
  expect('B7 状态为已暂停', paused.state === 'paused', paused.state);
  expect('B8 暂停自动触发整段翻译', paused.passage.trigger === 'pause', paused.passage.trigger);
  expect('B9 整段译文非空且是中文', /[\u4e00-\u9fff]/.test(paused.passage.translation), paused.passage.translation.slice(0, 120));
  expect('B10 整段译文覆盖全部已累积句子',
    paused.passage.covered === paused.passage.total && paused.passage.total >= 2, paused.passage);
  expect('B11 走的是真实翻译模式（不是预置/模板）',
    paused.passage.modes.length > 0 && paused.passage.modes.every((m) => m !== 'mock'),
    paused.passage.modes);
  expect('B12 逐句轨一条一条保持不变', paused.lines.length === beforePause.lines.length,
    { before: beforePause.lines.length, after: paused.lines.length });
  expect('B13 暂停期间不对每片段生成回复',
    !apiCalls.some((call) => call.url.endsWith('/api/reply')), apiCalls.filter((c) => c.url.includes('reply')));
  const passageText = await page.$eval('[data-testid="tab-audio-passage-translation"]', (el) => el.textContent.trim());
  expect('B14 整段译文显示在第二条轨道', passageText.length > 0 && passageText === paused.passage.translation,
    passageText.slice(0, 80));
  const translateCalls = apiCalls.filter((call) => call.url.includes('/api/translate')).length;
  record('TRANSLATE_CALLS', translateCalls);

  /* ---- 6. 继续采集：不重新授权、译文标过期 ---------------------------- */
  await page.click('[data-testid="tab-audio-resume"]');
  await sleep(400);
  const resumed = await snapshot();
  expect('B15 继续后回到采集中', resumed.state === 'capturing', resumed.state);
  const tracksLive = await page.evaluate(() =>
    window.__P3_DEST__.stream.getTracks().every((track) => track.readyState === 'live'));
  expect('B16 继续不需重新选择标签页（轨道未释放）', tracksLive, tracksLive);
  expect('B17 继续不会清空逐句字幕', resumed.lines.length >= beforePause.lines.length,
    { before: beforePause.lines.length, after: resumed.lines.length });

  await page.evaluate(() => {
    const ctx = window.__P3_CTX__;
    const source = ctx.createBufferSource();
    source.buffer = window.__P3_LATER__;
    source.connect(window.__P3_DEST__);
    source.start();
  });
  await page.waitForFunction(
    (before) => (window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().lines.length ?? 0) > before,
    { timeout: 120000, polling: 500 },
    beforePause.lines.length,
  );
  await sleep(1500);
  const stale = await snapshot();
  record('STALE', { total: stale.passage.total, covered: stale.passage.covered, stale: stale.passage.stale });
  expect('B18 继续后有新句子进入累积全文', stale.transcript.length > beforePause.transcript.length,
    { before: beforePause.transcript.length, after: stale.transcript.length });
  expect('B19 整段译文如实标记过期', stale.passage.stale === true &&
    stale.passage.total > stale.passage.covered, stale.passage);
  const staleBanner = await page.evaluate(() =>
    document.querySelector('[data-testid="tab-audio-passage"]')?.textContent ?? '');
  expect('B20 界面明说它是快照、不是实时译文',
    staleBanner.includes('还没纳入') && staleBanner.includes('不是实时译文'), staleBanner.slice(0, 200));

  /* ---- 7. 手动刷新整段译文 -------------------------------------------- */
  await page.click('[data-testid="tab-audio-passage-refresh"]');
  await page.waitForFunction(
    () => window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().passage.trigger === 'manual' &&
      window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().passage.status === 'done',
    { timeout: 120000, polling: 400 },
  );
  const refreshed = await snapshot();
  expect('B21 手动刷新后覆盖到最新句子', refreshed.passage.covered === refreshed.passage.total,
    refreshed.passage);
  expect('B22 手动刷新后不再标过期', refreshed.passage.stale === false, refreshed.passage.stale);
  expect('B23 刷新触发来源如实标注', refreshed.passage.trigger === 'manual', refreshed.passage.trigger);

  /* ---- 8. 停止：自动整段翻译 + 释放全部轨道 --------------------------- */
  await page.click('[data-testid="tab-audio-stop"]');
  await page.waitForFunction(
    () => window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().passage.trigger === 'stop' &&
      window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().passage.status === 'done',
    { timeout: 120000, polling: 400 },
  );
  const stopped = await snapshot();
  const released = await page.evaluate(() =>
    window.__P3_DEST__.stream.getTracks().every((track) => track.readyState === 'ended'));
  expect('B24 状态为已停止', stopped.state === 'stopped', stopped.state);
  expect('B25 停止自动触发整段翻译', stopped.passage.trigger === 'stop', stopped.passage.trigger);
  expect('B26 全部采集轨道已释放', released, released);
  expect('B27 停止后逐句字幕不再增加', stopped.lines.length === stale.lines.length,
    { before: stale.lines.length, after: stopped.lines.length });

  /* ---- 9. 用全部内容生成回复 ------------------------------------------ */
  await page.click('[data-testid="tab-audio-passage-use"]');
  await page.waitForSelector('[data-testid^="reply-en-"]', { timeout: 120000 });
  const fromPassage = await page.evaluate(() => ({
    original: document.querySelector('[data-testid="original-input"]')?.value ?? '',
    replies: Array.from(document.querySelectorAll('[data-testid^="reply-en-"]'))
      .map((el) => el.textContent.trim()),
  }));
  record('PASSAGE_REPLIES', fromPassage);
  expect('B28 主流程拿到的是整段原文', fromPassage.original.split('. ').length >= 2 ||
    fromPassage.original.length > 40, fromPassage.original.slice(0, 160));
  expect('B29 基于全部内容仍有三张回复卡', fromPassage.replies.length === 3, fromPassage.replies.length);
  expect('B30 回复卡不是旧的三句固定回复', fromPassage.replies.join('|') !== oldThree.join('|'), fromPassage.replies);

  await page.screenshot({ path: path.join(OUT, 'p3-dual-track.png'), fullPage: true });
  record('SHOT', 'docs/evidence-web/p3-dual-track.png');

  /* ---- 10. 控制台 ----------------------------------------------------- */
  const unexpected = consoleErrors.filter((text) => !/ERR_ABORTED|net::ERR|favicon/i.test(text));
  expect('X1 无意外控制台错误', unexpected.length === 0, unexpected);

  fs.writeFileSync(
    path.join(OUT, 'p3-verify.json'),
    JSON.stringify({ base: BASE, at: new Date().toISOString(), steps, failures,
      audio: { first: firstWavs, later: laterWavs,
        source: 'Windows SAPI5 合成语音（非真人录音、非视频原声）' },
      movieReplies: movie, thanksReplies: thanks, moneyReplies: money,
      passage: stopped.passage, lines: stopped.lines, consoleErrors }, null, 2),
    'utf-8',
  );
} catch (error) {
  failures.push(`EXCEPTION ${String(error).slice(0, 300)}`);
  record('EXCEPTION', String(error).slice(0, 300));
  fs.writeFileSync(path.join(OUT, 'p3-verify.json'),
    JSON.stringify({ base: BASE, steps, failures, consoleErrors }, null, 2), 'utf-8');
} finally {
  await browser.close();
}

console.log(`\np3-verify: ${steps.length - failures.length} PASS / ${failures.length} FAIL`);
if (failures.length) {
  console.log(failures.map((item) => `  - ${item}`).join('\n'));
  process.exit(1);
}
