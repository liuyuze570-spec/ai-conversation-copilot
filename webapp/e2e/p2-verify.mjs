/**
 * P2 端到端验收（真 Chrome + 真实本地模型）。
 *
 * 音频来源：webapp/server/testdata/*.wav，是 Windows SAPI 合成的英语句子，
 * **不是真人录音、不是视频原声**。它们在浏览器里被解码成真实 PCM，
 * 经真实 MediaStream → AudioWorklet 切片 → 真实 POST /api/transcribe
 * → 本机 faster-whisper → 本机 ONNX 翻译 → 字幕。
 *
 * 因此这一轮能证明「切片/识别/断句/翻译/预算/取消」链路真的跑通；
 * 但**真人授权视频标签页**那一步脚本无法代替，文档里单独标未自动化验证。
 *
 * 跑之前：web.9 服务在 8901（WEB_BASE 可覆盖）。
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8901';
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

const wavFiles = ['s1-report.wav', 's4-new.wav', 's2-meeting.wav'];
const wavBase64 = wavFiles.map((name) => fs.readFileSync(path.join(WAV_DIR, name)).toString('base64'));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--font-render-hinting=none',
    '--lang=zh-CN',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage();
page.setDefaultTimeout(120000);
await page.setViewport({ width: 1000, height: 1200, deviceScaleFactor: 1 });
const consoleErrors = [];
const apiCalls = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
});
page.on('pageerror', (error) => consoleErrors.push(String(error).slice(0, 200)));
page.on('request', (req) => {
  if (req.url().includes('/api/')) apiCalls.push({ method: req.method(), url: req.url() });
});

const snapshot = () => page.evaluate(() => window.__COPILOT_TAB_AUDIO_TEST__?.snapshot() ?? null);

try {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="tab-audio-start"]');

  /* ---- 1. 版本与限制 ------------------------------------------------- */
  const health = await page.evaluate(async () => {
    const response = await fetch('/api/health');
    return response.json();
  });
  const webMinor = Number((health.version.match(/web\.(\d+)/) || [])[1] || 0);
  expect('V1 web.9 及以后的版本', webMinor >= 9, health.version);
  expect('V2 音频时长预算已生效', health.limits.audio_budget_seconds === 300, health.limits);
  expect('V3 单片上限与并发', health.limits.segment_max_seconds === 10 && health.limits.asr_concurrency === 1, health.limits);
  expect('V4 频率限制改为 90/分', health.limits.rate_per_min === 90, health.limits.rate_per_min);
  expect('V5 真实识别后端', health.mode.transcribe === 'local-whisper' && health.real.transcribe === true, health.mode);

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="tab-audio-start"]');

  /* ---- 2. 界面与诚实标注 --------------------------------------------- */
  const ui = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="tab-audio-start"]')?.closest('section');
    const text = panel?.textContent ?? '';
    return {
      startLabel: document.querySelector('[data-testid="tab-audio-start"]')?.textContent?.trim(),
      startDisabled: document.querySelector('[data-testid="tab-audio-start"]')?.disabled,
      stopDisabled: document.querySelector('[data-testid="tab-audio-stop"]')?.disabled,
      hasMicDisclaimer: text.includes('麦克风'),
      hasNoFrame: text.includes('画面轨不接元素'),
      hasSideBySide: text.includes('并排'),
      hasNoPerSliceReply: text.includes('不对每个小片段生成回复'),
      hasUntestedPlatforms: text.includes('未测试'),
      stateRole: document.querySelector('[data-testid="tab-audio-state"]')?.getAttribute('role'),
      videoElements: document.querySelectorAll('video').length,
      empty: Boolean(document.querySelector('[data-testid="tab-audio-empty"]')),
    };
  });
  expect('U1 开始按钮可用 / 停止按钮初始禁用', ui.startDisabled === false && ui.stopDisabled === true, ui);
  expect('U2 明确不用麦克风冒充', ui.hasMicDisclaimer, ui);
  expect('U3 明确不上传画面', ui.hasNoFrame && ui.videoElements === 0, ui);
  expect('U4 并排显示不冒充悬浮字幕', ui.hasSideBySide, ui);
  expect('U5 说明不对每片段生成回复', ui.hasNoPerSliceReply, ui);
  expect('U6 平台兼容标未测试', ui.hasUntestedPlatforms, ui);
  expect('U7 状态有 role=status', ui.stateRole === 'status', ui.stateRole);
  expect('U8 初始无字幕', ui.empty, ui);
  const hasOfficialCapture = await page.evaluate(() =>
    typeof navigator.mediaDevices?.getDisplayMedia === 'function');
  // 只验「浏览器提供正式捕获能力」，真人点选标签页那一步脚本无法代劳。
  expect('U9 浏览器具备正式标签页捕获能力', hasOfficialCapture, hasOfficialCapture);

  /* ---- 3. 注入真实音频流 --------------------------------------------- */
  const injected = await page.evaluate(async (encoded) => {
    const ctx = new AudioContext();
    await ctx.resume();
    const buffers = [];
    for (const b64 of encoded) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      buffers.push(await ctx.decodeAudioData(bytes.buffer));
    }
    const total = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const merged = ctx.createBuffer(1, total, ctx.sampleRate);
    let offset = 0;
    for (const buffer of buffers) {
      merged.copyToChannel(buffer.getChannelData(0), 0, offset);
      offset += buffer.length;
    }
    const source = ctx.createBufferSource();
    source.buffer = merged;
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);
    window.__P2_TEST_CTX__ = ctx;
    window.__P2_TEST_STREAM__ = destination.stream;
    source.start();
    await window.__COPILOT_TAB_AUDIO_TEST__.inject(destination.stream);
    return {
      audioTracks: destination.stream.getAudioTracks().length,
      videoTracks: destination.stream.getVideoTracks().length,
      seconds: Math.round((total / ctx.sampleRate) * 100) / 100,
      sampleRate: ctx.sampleRate,
    };
  }, wavBase64);
  record('INJECT', injected);
  expect('I1 注入的是真实音频轨', injected.audioTracks === 1 && injected.videoTracks === 0, injected);

  const afterStart = await snapshot();
  expect('I2 自检来源如实标注', afterStart.label === 'selftest-wav', afterStart);
  expect('I3 状态进入采集/等待声音',
    ['capturing', 'waiting-sound'].includes(afterStart.state), afterStart.state);

  /* ---- 4. 真识别 → 真翻译 → 字幕 ------------------------------------- */
  await page.waitForFunction(
    () => (window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().lines.length ?? 0) >= 1,
    { timeout: 120000, polling: 400 },
  );
  // 再等一会儿，让后续片段也跑完，好验顺序与预算。
  await sleep(9000);
  const live = await snapshot();
  const lines = live.lines;
  record('LINES', lines.map((l) => ({ seq: l.seq, text: l.text, translation: l.translation, totalMs: l.totalMs })));
  expect('L1 至少一条真实字幕', lines.length >= 1, lines.length);
  expect('L2 字幕原文非空', lines.every((l) => l.text.trim().length > 0), lines);
  expect('L3 译文非空（真实翻译返回）', lines.some((l) => l.translation.trim().length > 0), lines);
  const keywords = /report|folder|meeting|Tuesday|Thursday|budget|p\.m|office/i;
  expect('L4 原文命中测试音频里的真实词', keywords.test(lines.map((l) => l.text).join(' ')),
    lines.map((l) => l.text));
  expect('L5 识别模式是 local-whisper', lines.some((l) => l.asrMode === 'local-whisper'),
    lines.map((l) => l.asrMode));
  expect('L6 端到端延迟有实测值', lines.some((l) => l.totalMs > 0), lines.map((l) => l.totalMs));
  expect('L7 编号不重复且非乱序', lines.every((l, i) => i === 0 || l.seq >= lines[i - 1].seq),
    lines.map((l) => l.seq));

  const stats = live.stats;
  record('STATS', {
    slices: stats.slices, sent: stats.sent, silent: stats.silent,
    dropped: stats.dropped, lines: stats.lines, budgetLeft: stats.budgetLeft,
    totalMs: stats.totalMs,
  });
  expect('S1 产生了真实切片', stats.slices > 0, stats.slices);
  expect('S2 有片段真正上传识别', stats.sent > 0, stats.sent);
  expect('S3 音频预算确实按秒扣减',
    stats.budgetLeft !== null && stats.budgetLeft < 300 && stats.budgetLeft >= 0,
    stats.budgetLeft);
  expect('S4 有声音的切片都送了识别', stats.sent === stats.slices,
    { sent: stats.sent, slices: stats.slices });
  expect('S5 没有调用 /api/reply（不对每片段生成回复）',
    !apiCalls.some((call) => call.url.endsWith('/api/reply')),
    apiCalls.filter((c) => c.url.includes('reply')));
  expect('S6 识别请求只发 /api/transcribe',
    apiCalls.some((call) => call.url.includes('/api/transcribe')), apiCalls);
  expect('S7 无画面上传（页面无 video 元素）', ui.videoElements === 0, ui.videoElements);

  await page.screenshot({ path: path.join(OUT, 'p2-tab-audio.png'), fullPage: true });
  record('SHOT', 'docs/evidence-web/p2-tab-audio.png');

  /* ---- 5. 停止：取消排队 + 释放轨道 ---------------------------------- */
  await page.evaluate(() => window.__COPILOT_TAB_AUDIO_TEST__.stop());
  await sleep(2500);
  const stopped = await snapshot();
  const released = await page.evaluate(() =>
    window.__P2_TEST_STREAM__.getTracks().every((track) => track.readyState === 'ended'));
  expect('T1 状态为已停止', stopped.state === 'stopped', stopped.state);
  expect('T2 所有采集轨道已释放', released, released);
  expect('T3 停止后不再新增字幕', stopped.lines.length === lines.length,
    { before: lines.length, after: stopped.lines.length });
  expect('T4 停止后统计不再增长', stopped.stats.slices === stats.slices,
    { before: stats.slices, after: stopped.stats.slices });
  const buttonState = await page.evaluate(() => ({
    start: document.querySelector('[data-testid="tab-audio-start"]')?.disabled,
    stop: document.querySelector('[data-testid="tab-audio-stop"]')?.disabled,
  }));
  expect('T5 按钮回到可重新开始状态', buttonState.start === false && buttonState.stop === true, buttonState);

  /* ---- 5b. 纯静音流：无声音必须等待，绝不生成假字幕 ------------------- */
  const beforeQuiet = stopped.lines.length;
  await page.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    // 12 秒全零 PCM，真实 MediaStream，不是「什么都不发」的空测试。
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 12, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);
    window.__P2_QUIET_CTX__ = ctx;
    window.__P2_QUIET_STREAM__ = destination.stream;
    source.start();
    await window.__COPILOT_TAB_AUDIO_TEST__.inject(destination.stream);
  });
  await page.waitForFunction(
    () => (window.__COPILOT_TAB_AUDIO_TEST__?.snapshot().stats.slices ?? 0) >= 3,
    { timeout: 30000, polling: 300 },
  );
  const quiet = await snapshot();
  record('QUIET', { slices: quiet.stats.slices, silent: quiet.stats.silent,
    sent: quiet.stats.sent, lines: quiet.lines.length, state: quiet.state });
  expect('Q1 静音片全部判为静音', quiet.stats.silent === quiet.stats.slices, quiet.stats);
  expect('Q2 静音期间没有上传任何识别请求', quiet.stats.sent === 0, quiet.stats.sent);
  expect('Q3 静音期间不生成字幕', quiet.lines.length === beforeQuiet,
    { before: beforeQuiet, after: quiet.lines.length });
  expect('Q4 界面显示等待声音', quiet.state === 'waiting-sound', quiet.state);
  const quietDetail = await page.evaluate(() =>
    document.querySelector('[data-testid="tab-audio-state"]')?.textContent ?? '');
  expect('Q5 等待状态明确说明不会生成字幕', quietDetail.includes('不会生成字幕'), quietDetail);
  await page.evaluate(() => window.__COPILOT_TAB_AUDIO_TEST__.stop());

  /* ---- 6. 无音轨必须明确失败，不许拿麦克风顶上 ----------------------- */
  await page.evaluate(() => window.__COPILOT_TAB_AUDIO_TEST__.inject(new MediaStream()));
  await sleep(500);
  const noTrack = await snapshot();
  expect('E1 无音轨给明确错误', noTrack.error.includes('没有音频轨') && noTrack.state === 'error', noTrack);
  expect('E2 无音轨时没有产生字幕', noTrack.lines.length === lines.length, noTrack.lines.length);
  const errorRole = await page.evaluate(() =>
    document.querySelector('[data-testid="tab-audio-error"]')?.getAttribute('role'));
  expect('E3 错误有 role=alert', errorRole === 'alert', errorRole);
  await page.evaluate(() => window.__COPILOT_TAB_AUDIO_TEST__.stop());

  /* ---- 7. 「用这句继续」仍走原回复卡主流程 --------------------------- */
  const firstText = lines[0].text;
  await page.click(`[data-testid="tab-audio-use-${lines[0].seq}"]`);
  await page.waitForFunction(
    (expected) => (document.querySelector('[data-testid="original-input"]')?.value ?? '') === expected,
    { timeout: 30000 },
    firstText,
  );
  await page.waitForSelector('[data-testid^="reply-en-"]', { timeout: 120000 });
  const carried = await page.evaluate(() => ({
    original: document.querySelector('[data-testid="original-input"]')?.value,
    replies: document.querySelectorAll('[data-testid^="reply-en-"]').length,
  }));
  expect('C1 选中句子进入主流程', carried.original === firstText, carried);
  expect('C2 回复卡仍可用', carried.replies >= 1 && carried.replies <= 3, carried.replies);

  /* ---- 8. 控制台 ----------------------------------------------------- */
  const unexpected = consoleErrors.filter((text) => !/ERR_ABORTED|net::ERR|favicon/i.test(text));
  expect('X1 无意外控制台错误', unexpected.length === 0, unexpected);

  fs.writeFileSync(
    path.join(OUT, 'p2-verify.json'),
    JSON.stringify({ base: BASE, at: new Date().toISOString(), steps, failures,
      audio: { files: wavFiles, source: 'Windows SAPI5 合成语音（非真人录音、非视频原声）' },
      lines, stats, consoleErrors }, null, 2),
    'utf-8',
  );
} catch (error) {
  failures.push(`EXCEPTION ${String(error).slice(0, 300)}`);
  record('EXCEPTION', String(error).slice(0, 300));
  fs.writeFileSync(path.join(OUT, 'p2-verify.json'),
    JSON.stringify({ base: BASE, steps, failures, consoleErrors }, null, 2), 'utf-8');
} finally {
  await browser.close();
}

console.log(`\np2-verify: ${steps.length - failures.length} PASS / ${failures.length} FAIL`);
if (failures.length) {
  console.log(failures.map((item) => `  - ${item}`).join('\n'));
  process.exit(1);
}
