/**
 * 会话链路的端到端验证（真 Chrome，服务端由本脚本自己起停）。
 *
 * 要证明的是上一轮公网实测的那个故障不再出现：
 *   「未预置的英文一提交就提示会话过期，刷新重试还是过期」。
 *
 * 每个场景都复现一个生产环境里真实存在的丢会话原因，不是造假接口：
 *   A. 首次进入：会话没建好之前，真实调用按钮不可提交（健康徽标不算数）。
 *   B. Cookie 被丢掉（反向代理/浏览器隐私设置）：请求头这条路要顶上，
 *      而且必须复用**同一个**服务端会话，不能偷偷换新的（那等于重置配额）。
 *   C. 服务端进程重启（部署、OOM、换实例）：内存里的会话全没了。
 *      页面不许要求用户刷新，不许丢输入；重建一次会话并重试一次。
 *   D. 重建本身失败：只尝试一次，给可读提示和重试入口，绝不循环。
 *
 * 用法：
 *   node webapp/e2e/session-recovery.mjs [端口]      # 本地：自己起停服务，A–D 全跑
 *   WEB_BASE=https://… node webapp/e2e/session-recovery.mjs
 *                                                   # 线上：跑 A/B（含删 Cookie），
 *                                                   # C/D 需要重启进程，线上不做
 */
import puppeteer from 'puppeteer-core';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const PY = path.join(root, 'webapp/server/.venv/Scripts/python.exe');
const SERVER_DIR = path.join(root, 'webapp/server');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.argv[2] || 8311);
const EXTERNAL = (process.env.WEB_BASE || '').trim().replace(/\/$/, '');
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
// 线上地址带 `?sharecode=…`，接口也要带（平台侧的访问控制），不能直接拼在路径后面。
const ORIGIN = BASE.includes('?') ? BASE.split('?')[0] : BASE;
const QUERY = BASE.includes('?') ? `?${BASE.split('?')[1]}` : '';
const api = (p) => `${ORIGIN}${p}${QUERY}`;

const SENTENCE = 'The plumber will arrive at 9.40 on Wednesday, not Thursday.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
function startServer() {
  server = spawn(PY, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: SERVER_DIR,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
}
function stopServer() {
  if (!server) return;
  try {
    execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' });
  } catch {
    /* 已经退了 */
  }
  server = null;
}
async function waitHealth(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(api("/api/health"));
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = String(error?.cause?.code || error?.message || error);
    }
    await sleep(400);
  }
  throw new Error(`服务没起来：${last}`);
}

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none', '--lang=zh-CN'],
});

try {
  if (!EXTERNAL) startServer();
  const health0 = await waitHealth();
  console.log(`服务已起 · version=${health0.version} boot=${health0.diag?.boot} base=${BASE}`);

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1200 });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 160)));

  const calls = { translate: [], session: [] };
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/translate')) calls.translate.push({ phase: 'req', at: Date.now() });
    if (u.includes('/api/session')) calls.session.push({ phase: 'req', at: Date.now() });
  });
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/translate')) calls.translate.push({ phase: 'res', status: res.status(), at: Date.now() });
    if (u.includes('/api/session')) calls.session.push({ phase: 'res', status: res.status(), at: Date.now() });
  });

  async function waitTranslateResponses(from, count = 1, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = calls.translate.filter((c) => c.phase === 'res');
      if (res.length >= from + count) return res.slice(from);
      await sleep(120);
    }
    throw new Error(`没有等到足够的翻译响应（已有 ${calls.translate.filter((c) => c.phase === 'res').length}）`);
  }

  // 拦截器全程只开一次、只挂一个 handler，用 `mode` 切换行为。
  // 之前反复 enable/disable 会导致旧 handler 在关闭状态下调 continue() 而报错。
  let mode = 'pass';
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/session')) {
      if (mode === 'slowSession') {
        setTimeout(() => req.continue(), 2500);
        return;
      }
      if (mode === 'forgeOnce') {
        mode = 'pass';
        return req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            session_id: 'forged',
            token: 'forged-session-token-0123456789abcdef',
            ttl_seconds: 7200,
          }),
        });
      }
      if (mode === 'boomSession') {
        return req.respond({ status: 500, contentType: 'application/json', body: '{"error":{"code":"BOOM"}}' });
      }
    }
    return req.continue();
  });

  // ---- A. 首次进入：会话就绪前不可提交 -------------------------------------
  // 故意把 /api/session 拖慢 2.5 秒，才能真的看到「未就绪」这个状态。
  mode = 'slowSession';

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-testid="original-input"]');
  await page.click('[data-testid="original-input"]');
  await page.type('[data-testid="original-input"]', SENTENCE, { delay: 2 });

  const during = await page.evaluate(() => ({
    disabled: document.querySelector('[data-testid="translate"]')?.disabled,
    pendingHint: !!document.querySelector('[data-testid="session-pending"]'),
  }));
  ok('A1 会话未就绪时提交按钮不可用，并说明原因', during.disabled === true && during.pendingHint, JSON.stringify(during));

  await page.waitForFunction(
    () => document.querySelector('[data-testid="translate"]')?.disabled === false,
    { timeout: 20000 },
  );
  const afterReady = await page.evaluate(() => ({
    disabled: document.querySelector('[data-testid="translate"]')?.disabled,
    pendingHint: !!document.querySelector('[data-testid="session-pending"]'),
  }));
  ok('A2 会话就绪后按钮自动放开、提示消失', afterReady.disabled === false && !afterReady.pendingHint, JSON.stringify(afterReady));

  mode = 'pass';

  const resBeforeA = calls.translate.filter((c) => c.phase === 'res').length;
  await page.click('[data-testid="translate"]');
  const [firstRes] = await waitTranslateResponses(resBeforeA, 1);
  const firstText = await page.$eval('[data-testid="translation-text"]', (el) => el.textContent.trim());
  ok('A3 未预置英文拿到真实译文（HTTP 200，不是预置）', firstRes.status === 200 && /[一-龥]/.test(firstText), `${firstRes.status} · ${firstText}`);

  const sessionsAfterFirst = (await (await fetch(api("/api/health"))).json()).diag.sessions;

  // ---- B. Cookie 被丢掉：请求头顶上，且复用同一会话 ------------------------
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  const hadCookie = (await client.send('Network.getCookies', { urls: [BASE] })).cookies.some((c) => c.name === 'sid');
  await client.send('Network.deleteCookies', { name: 'sid', url: BASE });
  const left = (await client.send('Network.getCookies', { urls: [BASE] })).cookies.filter((c) => c.name === 'sid');
  ok('B0 测试前提：sid Cookie 确实被删掉了', hadCookie && left.length === 0, `hadCookie=${hadCookie} left=${left.length}`);

  const resBeforeB = calls.translate.filter((c) => c.phase === 'res').length;
  await page.click('[data-testid="translate"]');
  const bRes = await waitTranslateResponses(resBeforeB, 1);
  const afterCookieLoss = await page.$eval('[data-testid="translation-text"]', (el) => el.textContent.trim());
  const failedZoneB = await page.$('[data-testid="session-failed"]');
  ok(
    'B1 Cookie 丢失后仍能翻译（请求头这条路生效，且一次就成）',
    bRes.length === 1 && bRes[0].status === 200 && afterCookieLoss.length > 0 && !failedZoneB,
    `请求次数=${bRes.length} 状态=${bRes.map((r) => r.status).join(',')}`,
  );

  const sessionsAfterCookieLoss = (await (await fetch(api("/api/health"))).json()).diag.sessions;
  ok(
    'B2 没有偷偷换新会话（服务端会话数不变）',
    sessionsAfterCookieLoss === sessionsAfterFirst,
    `before=${sessionsAfterFirst} after=${sessionsAfterCookieLoss}`,
  );

  // ---- E. 手上的会话服务端不认识（等价于请求被另一个实例接走）-------------
  // 造法：让页面在初始化时拿到一个假 token（服务端没有这条会话），
  // 然后正常提交。这就是「进程重启 / 请求落到别的实例」在浏览器侧看到的样子。
  mode = 'forgeOnce';

  // 先删掉 Cookie，否则服务端会先认 Cookie 里的真会话，走不到「不认识的会话」这条路
  await client.send('Network.deleteCookies', { name: 'sid', url: ORIGIN });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-testid="original-input"]');
  await page.click('[data-testid="original-input"]');
  await page.type('[data-testid="original-input"]', SENTENCE, { delay: 1 });
  await page.waitForFunction(() => document.querySelector('[data-testid="translate"]')?.disabled === false, { timeout: 25000 });

  const resBeforeE = calls.translate.filter((c) => c.phase === 'res').length;
  await page.click('[data-testid="translate"]');
  const eRes = await waitTranslateResponses(resBeforeE, 2);
  const afterForge = await page.$eval('[data-testid="translation-text"]', (el) => el.textContent.trim());
  ok(
    'E1 服务端不认识的会话：先 403，自动重建后第二次拿到译文',
    eRes.length === 2 && eRes[0].status === 403 && eRes[1].status === 200 && afterForge.length > 0,
    eRes.map((r) => r.status).join(' → '),
  );
  ok('E2 自愈后页面没有停在错误态', !(await page.$('[data-testid="session-failed"]')), '');

  mode = 'pass';

  // ---- C. 服务端重启：自动重建并重试，不刷新、不丢输入 ---------------------
  if (EXTERNAL) {
    console.log('SKIP  C/D 需要重启服务进程，线上不做（线上覆盖 A/B/E，重启类证据由本地提供）');
  } else {
  stopServer();
  await sleep(800);
  startServer();
  const health1 = await waitHealth();
  ok('C0 服务端确实换了进程（boot 变了）', health1.diag.boot !== health0.diag.boot, `${health0.diag.boot} -> ${health1.diag.boot}`);

  const inputBefore = await page.$eval('[data-testid="original-input"]', (el) => el.value);
  const resBeforeC = calls.translate.filter((c) => c.phase === 'res').length;
  await page.click('[data-testid="translate"]');
  const cRes = await waitTranslateResponses(resBeforeC, 2);
  const afterRestart = await page.$eval('[data-testid="translation-text"]', (el) => el.textContent.trim());
  const failedAfterRestart = await page.$('[data-testid="session-failed"]');
  const inputAfter = await page.$eval('[data-testid="original-input"]', (el) => el.value);
  ok(
    'C1 进程重启后先 403 再自动重建，第二次拿到译文',
    cRes.length === 2 && cRes[0].status === 403 && cRes[1].status === 200 && afterRestart.length > 0 && !failedAfterRestart,
    cRes.map((r) => r.status).join(' → '),
  );
  ok('C2 用户输入没有被清掉', inputBefore === inputAfter && inputAfter === SENTENCE, inputAfter);

  const sessionsAfterRestart = (await (await fetch(api("/api/health"))).json()).diag.sessions;
  ok('C3 只重建出一个新会话', sessionsAfterRestart === 1, `sessions=${sessionsAfterRestart}`);

  // ---- D. 会话失效 + 重建也失败：只试一次，给提示和入口，不循环 -----------
  // 先把服务端再换一个进程（会话表清空，页面手上的会话一定失效），
  // 同时让 /api/session 返回 500，制造「失效了又建不起来」这个最坏情况。
  mode = 'boomSession';

  stopServer();
  await sleep(800);
  startServer();
  const health2 = await waitHealth();
  ok('D0 制造前提：服务端又换了一次进程，旧会话必然失效', health2.diag.boot !== health1.diag.boot, `${health1.diag.boot} -> ${health2.diag.boot}`);

  const sessBeforeD = calls.session.filter((c) => c.phase === 'res').length;
  const resBeforeD = calls.translate.filter((c) => c.phase === 'res').length;
  await page.click('[data-testid="translate"]');
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="retry-last"]') || !!document.querySelector('[data-testid="session-failed"]'),
    { timeout: 40000 },
  );
  await sleep(1500);
  const sessD = calls.session.filter((c) => c.phase === 'res').length - sessBeforeD;
  const resD = calls.translate.filter((c) => c.phase === 'res').slice(resBeforeD).map((r) => r.status);
  ok('D1 重建失败时只尝试一次，不循环', sessD === 1, `session 请求次数=${sessD}`);
  ok('D2 会话建不起来时不再发翻译（只有原请求那一次 403，不会重复扣额度）', resD.length === 1 && resD[0] === 403, resD.join(','));
  ok('D3 给出「重试一次」入口', !!(await page.$('[data-testid="retry-last"]')));

  const notice = await page.evaluate(
    () =>
      document.querySelector('[aria-live="polite"]')?.textContent?.trim() ||
      document.querySelector('[data-testid="session-failed"]')?.textContent?.trim() ||
      '',
  );
  ok('D4 失败提示可读、不暴露内部实现', /重试|会话|失败/.test(notice), notice.slice(0, 110));

  mode = 'pass';
  // 本组故意制造了 403/500，浏览器会把它们记成「资源加载失败」——
  // 那是测试自己造的，不是脚本错误。只查真正的 JS 报错。
  const jsErrors = consoleErrors.filter((text) => !/Failed to load resource/i.test(text));
  ok('D5 没有 JS 报错（网络 4xx/5xx 是测试自己造的，不算）', jsErrors.length === 0, JSON.stringify(jsErrors.slice(0, 3)));
  }
} finally {
  await browser.close();
  stopServer();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
const out = path.join(root, 'docs/evidence-web/session-recovery.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2), 'utf8');
process.exit(failed === 0 ? 0 : 1);
