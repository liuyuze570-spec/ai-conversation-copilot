/**
 * 稳定性 / 安全修复的回归单测。
 *
 * 全部 import 自 `dist/` —— 跑的就是打包进安装包的同一份代码，不是另写的替身。
 *
 * 覆盖：
 *   A. 切句状态机：100–200ms 短噪声 + 长静音、12s 时长上限、字节上限、迟滞
 *   B. 密钥绑定：脱敏、host 归一、跨服务商拦截
 *   C. 接口地址：公网强制 https、本机放行、境外拦截、http 自动升级
 *   D. 回复 JSON：类型错、结构错、重复、未知枚举
 *   E. HTTP：慢响应体超时、401 不重试、429 重试、非 JSON、外部取消
 *   F. 失败后恢复
 *
 * 不联网、不碰真实 Key、不录音，全部在本地回环：
 *   E 段起一个 127.0.0.1 上的 HTTP 服务，专门模拟慢 body / 401 / 429。
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import assert from 'node:assert';

const require = createRequire(import.meta.url);

const segment = require('../dist/shared/segment-vad.js');
const keyBinding = require('../dist/shared/key-binding.js');
const providers = require('../dist/shared/providers.js');
const replyParse = require('../dist/services/llm/reply-parse.js');
const httpMod = require('../dist/services/llm/http.js');
const heal = require('../dist/main/audio/status-heal.js');

let total = 0;
let failed = 0;

function eq(actual, expected, msg) {
  total += 1;
  try {
    assert.deepStrictEqual(actual, expected);
  } catch {
    failed += 1;
    console.log(`  FAIL ${msg}\n    实际: ${JSON.stringify(actual)}\n    期望: ${JSON.stringify(expected)}`);
  }
}

function ok(cond, msg, extra) {
  total += 1;
  if (!cond) {
    failed += 1;
    console.log(`  FAIL ${msg}${extra === undefined ? '' : ' -> ' + extra}`);
  }
}

const section = (name) => console.log(`\n== ${name} ==`);

// --------------------------------------------------------------------------- //
// A. 切句状态机
// --------------------------------------------------------------------------- //
section('A. 切句状态机（短噪声 / 上限 / 迟滞）');

const CFG = {
  chunkMs: 100,
  minSpeechChunks: 3,
  maxSegmentMs: 12_000,
  maxSegmentBytes: 384_000,
  vadSilenceMs: 900,
};
const TH = { start: 200, keep: 120 };
const FRAME_BYTES = 3200; // 16kHz mono int16 × 100ms

function feed(state, rms, cfg = CFG) {
  return segment.decideSegment(state, { rms, bytes: FRAME_BYTES }, TH, cfg);
}

// A1：100ms 短噪声（1 块）+ 持续静音 —— 必须整段丢弃，且内存不再增长。
{
  let state = { ...segment.EMPTY_SEGMENT };
  let actions = [];
  actions.push(feed(state, 1000).action); // start
  state = feed(state, 1000).next;

  // 之后 60 秒全是静音。旧实现会一直 append，缓冲区一路涨到 60 秒。
  let droppedAt = -1;
  for (let i = 0; i < 600; i += 1) {
    const d = feed(state, 0);
    state = d.next;
    if (d.action === 'drop') {
      droppedAt = i;
      break;
    }
    if (d.action === 'finish') {
      droppedAt = -2;
      break;
    }
  }
  eq(actions[0], 'start', 'A1 短噪声能起了一段');
  eq(droppedAt, 8, 'A1 900ms 静音后立刻丢弃（第 9 个静音块）');
  eq(state.speaking, false, 'A1 丢弃后回到「没在说」');
  eq(state.bytes, 0, 'A1 缓冲区已清空，不会无限增长');
}

// A2：短噪声之后再来 60 秒静音，任何时候都不该出现「finish」
{
  let state = { ...segment.EMPTY_SEGMENT };
  state = feed(state, 1000).next;
  let sawFinish = false;
  let maxBytes = 0;
  for (let i = 0; i < 600; i += 1) {
    const d = feed(state, 0);
    state = d.next;
    maxBytes = Math.max(maxBytes, state.bytes);
    if (d.action === 'finish') sawFinish = true;
  }
  ok(!sawFinish, 'A2 短噪声不会被当成一句话送出去');
  ok(maxBytes <= FRAME_BYTES * 9, 'A2 缓冲区最大不超过 900ms 的量', maxBytes);
}

// A3：正常一句话（1 秒语音 + 0.9 秒静音）→ finish
{
  let state = { ...segment.EMPTY_SEGMENT };
  let last = null;
  for (let i = 0; i < 10; i += 1) {
    last = feed(state, 1000);
    state = last.next;
  }
  eq(state.speechChunks, 10, 'A3 记下 10 块语音');
  for (let i = 0; i < 9 && (!last || last.action !== 'finish'); i += 1) {
    last = feed(state, 0);
    state = last.next;
  }
  eq(last.action, 'finish', 'A3 停顿到位后收官');
  eq(state.speaking, false, 'A3 收官后状态复位');
}

// A4：一直很响、没有停顿 —— 12 秒上限**必须独立生效**（旧实现和平滑语音块绑在一起）
{
  let state = { ...segment.EMPTY_SEGMENT };
  let finishAtChunk = -1;
  for (let i = 0; i < 400; i += 1) {
    const d = feed(state, 5000);
    state = d.next;
    if (d.action === 'finish') {
      finishAtChunk = i + 1;
      eq(d.reason, 'max-duration', 'A4 收官原因是 max-duration');
      break;
    }
  }
  eq(finishAtChunk, 120, 'A4 第 120 块（12 秒）强制收官，哪怕一直没人停');
}

// A5：字节上限是独立闸门（把时长上限调到很大）
{
  const cfg = { ...CFG, maxSegmentMs: 999_999, maxSegmentBytes: 9600 };
  let state = { ...segment.EMPTY_SEGMENT };
  let finishAt = -1;
  for (let i = 0; i < 20; i += 1) {
    const d = feed(state, 5000, cfg);
    state = d.next;
    if (d.action === 'finish') {
      finishAt = i + 1;
      break;
    }
  }
  eq(finishAt, 3, 'A5 第 3 块达到 9600 字节就收官');
}

// A6：迟滞 —— 说话中间降到 keep 与 start 之间，仍算「在说」，不该被切断
{
  let state = { ...segment.EMPTY_SEGMENT };
  for (let i = 0; i < 5; i += 1) state = feed(state, 1000).next;
  const mid = feed(state, 160); // 160 > keep(120) 但 < start(200)
  eq(mid.action, 'append', 'A6 中间音量不切断');
  eq(mid.next.silenceChunks, 0, 'A6 不计入静音块');
}

// A7：反向对照 —— 用**旧规则**跑同样的输入，证明这套测试不是白测的。
// 旧条件：enoughSpeech && (silenceMs >= vadSilenceMs || elapsedMs >= MAX_SEGMENT_MS)
// 两个上限都被 enoughSpeech 卡住，短噪声永远收不了官。
{
  const old = (speech, silence) =>
    speech >= CFG.minSpeechChunks &&
    (silence * CFG.chunkMs >= CFG.vadSilenceMs || (speech + silence) * CFG.chunkMs >= CFG.maxSegmentMs);

  // 1 块语音 + 600 块静音（60 秒）
  let finished = false;
  let bytes = FRAME_BYTES;
  for (let silence = 1; silence <= 600; silence += 1) {
    bytes += FRAME_BYTES;
    if (old(1, silence)) {
      finished = true;
      break;
    }
  }
  ok(!finished, 'A7 反向对照：旧规则下 60 秒静音也收不了官（这就是内存泄漏）');
  ok(bytes > 384_000, 'A8 反向对照：旧规则缓冲区涨到 1.8MB 以上', `${Math.round(bytes / 1024)}KB`);

  // 而新规则在同样的输入下早就丢掉了（A1/A2 已断言）。
  let state = { ...segment.EMPTY_SEGMENT };
  state = feed(state, 1000).next;
  for (let i = 0; i < 600; i += 1) state = feed(state, 0).next;
  eq(state.bytes, 0, 'A9 新规则同样输入下缓冲区为 0');
}

// --------------------------------------------------------------------------- //
// B. 密钥绑定
// --------------------------------------------------------------------------- //
section('B. 密钥与服务商绑定');

eq(keyBinding.bindingHostOf('https://api.siliconflow.cn/v1'), 'api.siliconflow.cn', 'B1 取 host');
eq(keyBinding.bindingHostOf('api.deepseek.com/v1'), 'api.deepseek.com', 'B2 没写协议也能取');
eq(keyBinding.bindingHostOf(''), '', 'B3 空串返回空');
eq(keyBinding.bindingHostOf('http://localhost:11434/v1'), 'localhost', 'B4 本机地址');

{
  const masked = keyBinding.maskKey('sk-1234567890abcdef');
  ok(masked.includes('••••'), 'B5 脱敏里有掩码', masked);
  ok(masked.startsWith('sk-1') && masked.endsWith('cdef'), 'B6 只露头尾', masked);
  ok(!masked.includes('234567890abc'), 'B7 中间那截不出现', masked);
  ok(masked.length < 20, 'B8 脱敏后比原文短', masked.length);
}
eq(keyBinding.maskKey('short'), '••••••••', 'B9 太短就全遮');
eq(keyBinding.maskKey(''), '', 'B10 空串');

{
  const binding = { origin: 'https://api.siliconflow.cn', providerId: 'siliconflow', at: 1 };
  eq(keyBinding.keyBelongsTo(binding, 'https://api.siliconflow.cn/v1'), true, 'B11 同一家可以用');
  eq(
    keyBinding.keyBelongsTo(binding, 'https://api.deepseek.com/v1'),
    false,
    'B12 换了一家不许用（核心修复）',
  );
  eq(
    keyBinding.keyBelongsTo(binding, 'https://API.SILICONFLOW.CN/v1'),
    true,
    'B13 origin 大小写无关',
  );
  // 0.3.7 起：归属未知也**不能**用（审计：密钥归属未知或不匹配时停止使用）
  eq(
    keyBinding.keyOwnership(undefined, 'https://api.deepseek.com'),
    'unknown',
    'B14 没有归属记录 → unknown（停止使用，提示重填）',
  );
  eq(
    keyBinding.keyOwnership(binding, 'https://api.siliconflow.cn:8443/v1'),
    'mismatch',
    'B15 同主机换端口 = 另一台服务，必须拦住',
  );
  eq(
    keyBinding.keyOwnership(binding, 'http://api.siliconflow.cn/v1'),
    'mismatch',
    'B16 同主机降到 http 也要拦住（Key 会明文过链路）',
  );
  eq(
    keyBinding.keyOwnership({ origin: 'http://127.0.0.1:11434', providerId: 'custom', at: 1 }, 'http://127.0.0.1:8000/v1'),
    'mismatch',
    'B17 本机不同端口不能混用',
  );
  ok(
    keyBinding.mismatchMessage('https://api.siliconflow.cn', 'https://api.deepseek.com').includes(
      '不会发送',
    ),
    'B18 有不发送的明确说明',
  );
  ok(
    keyBinding.ownershipMessage('unknown', '', 'https://a.cn').includes('重新粘贴'),
    'B19 归属未知时明确要求重新粘贴',
  );
}

{
  // origin 规范化：协议 / 端口 / 默认端口 / 小写
  eq(
    keyBinding.bindingOriginOf('https://api.siliconflow.cn/v1'),
    'https://api.siliconflow.cn',
    'B20 去掉路径',
  );
  eq(keyBinding.bindingOriginOf('api.deepseek.com/v1'), 'https://api.deepseek.com', 'B21 补默认 https');
  eq(
    keyBinding.bindingOriginOf('http://127.0.0.1:11434/v1'),
    'http://127.0.0.1:11434',
    'B22 保留非默认端口',
  );
  eq(
    keyBinding.bindingOriginOf('https://api.x.cn:443/v1'),
    'https://api.x.cn',
    'B23 默认端口省略（否则同一个地址会有两种写法）',
  );
  eq(keyBinding.bindingOriginOf(''), '', 'B24 空串');
  eq(keyBinding.bindingOriginOf('ftp://a.cn'), '', 'B25 非 http(s) 协议不接受');
  eq(
    keyBinding.originOfBinding({ origin: '', host: 'api.old.cn', providerId: 'x', at: 1 }),
    'https://api.old.cn',
    'B26 0.3.6 的 host 旧绑定能换算成 origin',
  );

  /*
   * B27–B33：scheme 升级的跟随规则（迁移阶段用）。
   *
   * 老用户配置里写 `http://api.siliconflow.cn/v1`，Key 绑定到 http origin；
   * 启动时端点迁移把地址升级成 https。绑定不跟着走的话，严格比对就判成
   * 「不匹配」，用户没换服务商却被停用 Key。
   */
  const httpBind = { origin: 'http://api.siliconflow.cn', providerId: 'siliconflow', at: 1 };
  eq(
    keyBinding.followSchemeUpgrade(httpBind, 'https://api.siliconflow.cn/v1'),
    'https://api.siliconflow.cn',
    'B27 同一主机的 http→https 跟随升级',
  );
  eq(
    keyBinding.followSchemeUpgrade(httpBind, 'https://api.deepseek.com/v1'),
    '',
    'B28 换了服务商绝不跟随',
  );
  eq(
    keyBinding.followSchemeUpgrade(
      { origin: 'https://api.siliconflow.cn', providerId: 'x', at: 1 },
      'http://api.siliconflow.cn/v1',
    ),
    '',
    'B29 反方向（https→http）不跟随，降级等于明文发 Key',
  );
  eq(
    keyBinding.followSchemeUpgrade(
      { origin: 'http://127.0.0.1:8000', providerId: 'x', at: 1 },
      'https://127.0.0.1:8001/v1',
    ),
    '',
    'B30 端口不同不跟随（那是另一台服务）',
  );
  eq(
    keyBinding.followSchemeUpgrade(
      { origin: 'http://127.0.0.1:8000', providerId: 'x', at: 1 },
      'https://127.0.0.1:8000/v1',
    ),
    'https://127.0.0.1:8000',
    'B31 本机同端口可以跟随（协议升级，主机端口都不变）',
  );
  eq(
    keyBinding.followSchemeUpgrade(
      { origin: '', host: 'api.old.cn', providerId: 'x', at: 1 },
      'https://api.old.cn/v1',
    ),
    '',
    'B32 旧 host 绑定换算出来已经是 https，不需要再跟随',
  );
  // 跟随之后仍按严格 origin 比对，规则本身没有被放宽
  const upgraded = keyBinding.followSchemeUpgrade(httpBind, 'https://api.siliconflow.cn/v1');
  eq(
    keyBinding.keyOwnership({ ...httpBind, origin: upgraded }, 'https://api.siliconflow.cn/v1'),
    'ok',
    'B33 跟随改写之后严格比对判为 ok',
  );
  eq(
    keyBinding.keyOwnership({ ...httpBind, origin: upgraded }, 'https://api.siliconflow.cn:8443/v1'),
    'mismatch',
    'B34 改写后再换端口依然是 mismatch',
  );
}

// --------------------------------------------------------------------------- //
// C. 接口地址
// --------------------------------------------------------------------------- //
section('C. 公网 https / 本机 / 境外');

{
  const insecure = providers.checkDomesticURL('http://api.siliconflow.cn/v1');
  eq(insecure.ok, false, 'C1 公网 http 被拒');
  eq(insecure.insecure, true, 'C2 标记为「只是缺 https」');
  ok((insecure.reason || '').includes('https'), 'C3 提示里说了改成 https');

  const local = providers.checkDomesticURL('http://localhost:11434/v1');
  eq(local.ok, true, 'C4 本机 http 放行');
  eq(local.local, true, 'C5 标记为本机');

  const lan = providers.checkDomesticURL('http://192.168.1.20:8080/v1');
  eq(lan.ok, true, 'C6 内网 http 放行');

  eq(providers.checkDomesticURL('https://api.siliconflow.cn/v1').ok, true, 'C7 正常 https 放行');
  eq(providers.checkDomesticURL('https://api.openai.com/v1').ok, false, 'C8 境外接口仍然拦截');
  eq(providers.checkDomesticURL('').ok, false, 'C9 空地址不通过');

  eq(providers.enforceHttps('http://api.deepseek.com/v1'), 'https://api.deepseek.com/v1', 'C10 自动升级 https');
  eq(providers.enforceHttps('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1', 'C11 本机不升级');
  eq(providers.enforceHttps('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1', 'C12 已是 https 不动');
}

// --------------------------------------------------------------------------- //
// D. 回复 JSON 结构校验
// --------------------------------------------------------------------------- //
section('D. 回复 JSON 结构校验');

{
  const dirty = replyParse.parseReplyDrafts({
    replies: [
      { kind: 'natural', english: 'Yeah, that makes sense.', chinese: 123 },
      { kind: '不存在的类型', english: '  Sure.  ', chinese: '当然。' },
      { kind: 'simple', english: 'Yeah, that makes sense.' },
      { english: 'Only english.', chinese: '只有英文。', syllables: 'not-an-array' },
    ],
  });
  eq(dirty.length, 3, 'D1 重复句被去掉（4 条 → 3 条）');
  eq(dirty[0].chinese, '', 'D2 chinese 是数字 → 收敛成空串，不抛错');
  eq(dirty[1].english, 'Sure.', 'D3 首尾空格被去掉');
  eq(dirty[1].kind, 'natural', 'D4 未知 kind → natural');
  eq(dirty[2].syllables, undefined, 'D5 syllables 不是数组 → 丢弃');
  ok(dirty.every((d) => typeof d.english === 'string' && d.english.length > 0), 'D6 每条都有可用英文');
}

eq(replyParse.parseReplyDrafts({ replies: 'oops' }).length, 0, 'D7 replies 是字符串 → 空数组');
eq(replyParse.parseReplyDrafts(null).length, 0, 'D8 null → 空数组');
eq(replyParse.parseReplyDrafts('plain text').length, 0, 'D9 纯文本 → 空数组');

{
  const single = replyParse.parseReplyDrafts({ english: 'Hi.', chinese: '嗨。' });
  eq(single.length, 1, 'D10 漏包一层的单张卡也认');
}
{
  const arr = replyParse.parseReplyDrafts([{ english: 'A.' }, { english: 'B.' }]);
  eq(arr.length, 2, 'D11 顶层数组也认');
}
{
  const many = replyParse.parseReplyDrafts({
    replies: [1, 2, 3, 4, 5].map((n) => ({ english: `Line ${n}.` })),
  });
  eq(many.length, 3, 'D12 最多 3 条');
}
{
  const kinds = replyParse.parseReplyDrafts({
    replies: [
      { english: 'A.', kind: 'simple' },
      { english: 'B.', kind: 'continue' },
    ],
  });
  eq(kinds.map((d) => d.kind), ['simple', 'continue'], 'D13 合法 kind 原样保留');
}

// --------------------------------------------------------------------------- //
// E. HTTP：超时 / 重试 / 取消（本地回环，不联网）
// --------------------------------------------------------------------------- //
section('E. HTTP 超时与重试');

const stats = { auth: 0, ratelimit: 0, slow: 0 };

const server = http.createServer((req, res) => {
  if (req.url === '/auth') {
    stats.auth += 1;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    return;
  }
  if (req.url === '/ratelimit') {
    stats.ratelimit += 1;
    if (stats.ratelimit < 3) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/slow-body') {
    stats.slow += 1;
    // 头立刻发出去，body 永远不发 —— 这正是「超时只管到响应头」的旧 bug 场景。
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
    return;
  }
  if (req.url === '/html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>gateway error</body></html>');
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// E1：慢响应体必须在总预算内被掐断
{
  const started = Date.now();
  let error = null;
  try {
    await httpMod.requestText(`${base}/slow-body`, { method: 'GET' }, { timeoutMs: 400, retries: 0 });
  } catch (e) {
    error = e;
  }
  const elapsed = Date.now() - started;
  ok(error !== null, 'E1 慢响应体最终抛错（没有永远挂住）');
  eq(error && error.message, 'HTTP_TIMEOUT', 'E2 错误是 HTTP_TIMEOUT');
  ok(elapsed < 1500, 'E3 在预算内返回（不是永久等待）', `${elapsed}ms`);
}

// E4：401 重试一次都不该有
{
  stats.auth = 0;
  const result = await httpMod.requestText(`${base}/auth`, { method: 'POST' }, { timeoutMs: 5000, retries: 2 });
  eq(result.status, 401, 'E4 401 原样返回给调用方');
  eq(result.ok, false, 'E5 ok=false');
  eq(stats.auth, 1, 'E6 鉴权失败只请求了 1 次（不重试）');
  ok(httpMod.errorDetailFromText(result.text).includes('invalid api key'), 'E7 能读出服务商给的原因');
}

// E8：429 应该重试，最终成功
{
  stats.ratelimit = 0;
  const result = await httpMod.requestJson(`${base}/ratelimit`, { method: 'GET' }, { timeoutMs: 8000, retries: 2 });
  eq(result.ok, true, 'E8 限流后重试到成功');
  eq(stats.ratelimit, 3, 'E9 一共请求 3 次（2 次 429 + 1 次成功）');
  eq(result.data, { ok: true }, 'E10 JSON 正常解析');
}

// E11：返回 HTML 时 data 为 null，但不抛错（调用方拿 text 报错）
{
  const result = await httpMod.requestJson(`${base}/html`, { method: 'GET' }, { timeoutMs: 3000, retries: 0 });
  eq(result.data, null, 'E11 非 JSON → data 为 null');
  ok(result.text.includes('gateway error'), 'E12 原始文本保留下来可以报给用户');
}

// E13：外部取消要立刻结束底层请求
{
  const controller = new AbortController();
  const started = Date.now();
  const promise = httpMod
    .requestText(`${base}/slow-body`, { method: 'GET' }, { timeoutMs: 10_000, retries: 0, signal: controller.signal })
    .then(() => 'resolved')
    .catch((e) => e.message);
  setTimeout(() => controller.abort(), 120);
  const outcome = await promise;
  const elapsed = Date.now() - started;
  eq(outcome, 'ABORT', 'E13 取消后抛出 ABORT');
  ok(elapsed < 1200, 'E14 取消立即生效，不等超时', `${elapsed}ms`);
}

// E15：已经是 aborted 的信号，连请求都不该发
{
  const before = stats.slow;
  const controller = new AbortController();
  controller.abort();
  const outcome = await httpMod
    .requestText(`${base}/slow-body`, { method: 'GET' }, { timeoutMs: 5000, retries: 0, signal: controller.signal })
    .then(() => 'resolved')
    .catch((e) => e.message);
  eq(outcome, 'ABORT', 'E15 已取消的信号直接抛 ABORT');
  eq(stats.slow, before, 'E16 没有真的发出请求');
}

server.close();

// --------------------------------------------------------------------------- //
// F. 失败后恢复
// --------------------------------------------------------------------------- //
section('F. 识别失败后的状态恢复');

eq(heal.healsAfterSuccess('error'), true, 'F1 error 之后成功 → 要捞回 listening');
eq(heal.healsAfterSuccess('no-audio'), true, 'F2 no-audio 之后成功 → 捞回');
eq(heal.healsAfterSuccess('listening'), false, 'F3 本来就是 listening → 不用重复报');
eq(heal.healsAfterSuccess('paused'), false, 'F4 用户主动暂停 → 不许被识别结果推翻');

// --------------------------------------------------------------------------- //
// G. 长时间运行 / 长静音下的内存有界性
// --------------------------------------------------------------------------- //
section('G. 30 分钟运行 + 每 20 秒一次短噪声，缓冲区是否有界');

{
  // 按真实 AudioStream 的方式模拟：只保留「当前段」的块，其余立刻释放。
  let state = { ...segment.EMPTY_SEGMENT };
  let chunks = [];
  let peakBytes = 0;
  let finished = 0;
  let dropped = 0;
  let totalFrames = 0;

  const heapBefore = process.memoryUsage().heapUsed;

  // 30 分钟 = 1800 秒 = 18000 个 100ms 帧
  for (let i = 0; i < 18_000; i += 1) {
    totalFrames += 1;
    // 每 20 秒来一次 150ms 的短噪声（模拟点鼠标 / 提示音）
    const blip = i % 200 < 2;
    const speech = i % 2000 < 15; // 每 200 秒说一句 1.5 秒的话
    const rms = blip ? 900 : speech ? 1200 : 5;

    const d = feed(state, rms);
    state = d.next;

    if (d.action === 'start') chunks = [Buffer.alloc(FRAME_BYTES)];
    else if (d.action === 'append') chunks.push(Buffer.alloc(FRAME_BYTES));
    else if (d.action === 'finish') {
      chunks.push(Buffer.alloc(FRAME_BYTES));
      finished += 1;
      chunks = [];
    } else if (d.action === 'drop') {
      dropped += 1;
      chunks = [];
    }

    peakBytes = Math.max(peakBytes, chunks.length * FRAME_BYTES);
  }

  const heapAfter = process.memoryUsage().heapUsed;
  const framesPerMinute = 600;
  ok(
    peakBytes <= CFG.maxSegmentBytes,
    'G1 任意时刻缓冲区不超过单段上限',
    `${Math.round(peakBytes / 1024)}KB <= ${Math.round(CFG.maxSegmentBytes / 1024)}KB`,
  );
  ok(
    peakBytes <= FRAME_BYTES * 130,
    'G2 峰值只有一段话的量（≈13 秒），不随运行时长增长',
    `${Math.round(peakBytes / 1024)}KB`,
  );
  ok(dropped > 50, 'G3 短噪声都走了「丢弃」分支', dropped);
  ok(finished >= 8, 'G4 真正的句子仍然正常收官', finished);
  ok(
    heapAfter - heapBefore < 40 * 1024 * 1024,
    'G5 18 分钟帧循环的堆增长 < 40MB（没有累积泄漏）',
    `${Math.round((heapAfter - heapBefore) / 1024 / 1024)}MB`,
  );
  ok(totalFrames === 18_000, 'G6 循环确实跑满了 18000 帧（30 分钟）');
  console.log(
    `  信息: ${totalFrames} 帧 / 收官 ${finished} 段 / 丢弃 ${dropped} 段 / 峰值 ${Math.round(peakBytes / 1024)}KB`,
  );
}

console.log('\n== H. 音频管线启动幂等（开机双启动） ==\n');
{
  const gate = require('../dist/shared/pipeline-gate.js');
  const base = {
    mockMode: false,
    captureSystemAudio: true,
    captureMicrophone: false,
    systemDeviceId: 'default',
    micDeviceId: 'default',
    pythonPath: '',
    demoAutoPlay: false,
    targetLanguage: 'English',
  };
  const sig = gate.pipelineSignature(base);

  ok(sig.length > 0, 'H1 指纹非空', sig);
  ok(gate.pipelineSignature({ ...base }) === sig, 'H2 相同配置指纹一致（两次启动应判为重复）');
  ok(
    gate.shouldRestartPipeline('', base) === true,
    'H3 没有管线在跑时必须启动（停止后点开始要能起来）',
  );
  ok(
    gate.shouldRestartPipeline(sig, base) === false,
    'H4 管线在跑 + 配置没变 -> 忽略重复的启动请求（修掉开机双启动）',
  );
  ok(
    gate.shouldRestartPipeline(sig, { ...base, captureMicrophone: true }) === true,
    'H5 打开麦克风 -> 必须重建',
  );
  ok(
    gate.shouldRestartPipeline(sig, { ...base, systemDeviceId: 'dev-2' }) === true,
    'H6 换采集设备 -> 必须重建',
  );
  ok(
    gate.shouldRestartPipeline(sig, { ...base, mockMode: true }) === true,
    'H7 切演示模式 -> 必须重建',
  );
  // 真实模式下改语言不该把正在录的系统声音拆掉
  ok(
    gate.shouldRestartPipeline(sig, { ...base, targetLanguage: 'Japanese' }) === false,
    'H8 真实模式换目标语言 -> 不重建（不打断正在采集的音频）',
  );
  // 演示模式下语言是引擎自己排的，必须重建才生效
  const mockSig = gate.pipelineSignature({ ...base, mockMode: true });
  ok(
    gate.shouldRestartPipeline(mockSig, { ...base, mockMode: true, targetLanguage: 'Japanese' }) ===
      true,
    'H9 演示模式换目标语言 -> 必须重建（否则示例对话还是旧语言）',
  );
  ok(
    gate.shouldRestartPipeline(mockSig, { ...base, mockMode: true, demoAutoPlay: true }) === true,
    'H10 演示模式开关自动播放 -> 必须重建',
  );
  // 换识别服务商不需要拆采集：识别是每次调用现取的
  ok(
    gate.pipelineSignature({ ...base, sttProvider: 'another-vendor' }) === sig,
    'H11 指纹与 sttProvider 无关（换服务商不打断采集）',
  );
}

console.log('\n== I. 字幕译文四态（等待 / 成功 / 失败 / 取消） ==\n');
{
  const sub = require('../dist/shared/subtitle-state.js');

  const okDone = sub.translationView({ translatedText: '你好' });
  eq(okDone.state, 'ok', 'I1 有译文 = 成功');
  eq(okDone.canRetry, false, 'I2 成功的不需要重试入口');

  // 已经翻出半句、整句重译失败：能看懂的内容不能变回「翻译失败」
  const hasTextButFailed = sub.translationView({
    translatedText: '你好',
    translationState: 'failed',
  });
  eq(hasTextButFailed.state, 'ok', 'I3 有译文时即使状态是 failed 也按成功显示');

  const waiting = sub.translationView({ translationState: 'pending' });
  eq(waiting.state, 'pending', 'I4 pending 显示「翻译中」');
  eq(waiting.placeholder, '翻译中…', 'I5 pending 文案');
  eq(waiting.canRetry, false, 'I6 等待中不给重试（会和在途请求打架）');

  const failed = sub.translationView({ translationState: 'failed' });
  eq(failed.state, 'failed', 'I7 failed 显示「翻译失败」');
  eq(failed.placeholder, '翻译失败', 'I8 failed 文案');
  eq(failed.canRetry, true, 'I9 failed 必须给逐句重试入口');

  const cancelled = sub.translationView({ translationState: 'cancelled' });
  eq(cancelled.state, 'cancelled', 'I10 停止监听导致的取消单独成一态');
  eq(cancelled.placeholder, '已停止翻译', 'I11 取消不能用「失败」的字眼（那不是出错）');
  eq(cancelled.canRetry, true, 'I12 取消之后也能重试');

  const blank = sub.translationView({ translationState: undefined });
  eq(blank.state, 'idle', 'I13 没请求过翻译就不显示任何状态');
  eq(blank.placeholder, null, 'I14 idle 不占地方');
  eq(
    sub.translationView({ translatedText: '   ' }).state,
    'idle',
    'I15 纯空白的译文当作没有（别显示一行空白）',
  );

  // 停止监听：在途的 pending 变 cancelled，其余不动
  eq(sub.cancelPendingTranslation('pending'), 'cancelled', 'I16 pending -> cancelled');
  eq(sub.cancelPendingTranslation('failed'), 'failed', 'I17 已经失败的保持失败（别被抹成取消）');
  eq(sub.cancelPendingTranslation('ok'), 'ok', 'I18 成功的保持成功');
  eq(sub.cancelPendingTranslation(undefined), undefined, 'I19 没请求过的保持每请求过');
}

console.log('\n== J. 整段音频链路（handleFrame → finish → snapshot → enqueue） ==\n');
{
  /*
   * 这一段是 0.3.6 那个「最终音频被拼成空」的正面回归。
   *
   * 旧实现的 bug 是：先把 segmentState 重置（bytes → 0），再拿 bytes 去
   * Buffer.concat(list, 0) → 零长度 Buffer → `pcm.length >= MIN_FINAL_MS`
   * 永远不成立 → 最终识别从来没被提交过。
   *
   * 所以这里**不能只断言 action === 'finish'**（状态机本来就对），必须断言
   * 交出来的 pcm 字节数、以及「一段恰好提交一次」。
   */
  const { SegmentBuffer } = require('../dist/main/audio/segment-buffer.js');
  const frame = () => Buffer.alloc(FRAME_BYTES, 0x11);

  // 模拟引擎的 enqueue：收到的音频按顺序记下来。
  const enqueued = [];
  const feedFrames = (buffer, plan) => {
    let finishes = 0;
    let drops = 0;
    for (const rms of plan) {
      const outcome = buffer.push(frame(), rms, TH, CFG.vadSilenceMs);
      if (outcome.action === 'finish') {
        finishes += 1;
        enqueued.push(outcome.pcm);
      } else if (outcome.action === 'drop') {
        drops += 1;
      }
    }
    return { finishes, drops };
  };

  // 10 帧人声 + 9 帧静音（900ms 门槛 → 第 9 帧静音收官）
  const buffer = new SegmentBuffer(CFG);
  const plan = [...Array(10).fill(1200), ...Array(9).fill(5)];
  const first = feedFrames(buffer, plan);

  eq(first.finishes, 1, 'J1 一段人声恰好收官一次');
  eq(first.drops, 0, 'J2 不该被当成噪声丢掉');
  eq(enqueued.length, 1, 'J3 enqueue 只收到一次');
  ok(enqueued[0] && enqueued[0].length > 0, 'J4 pcm 非空（0.3.6 这里恒为 0 字节）');
  eq(
    enqueued[0]?.length,
    19 * FRAME_BYTES,
    'J5 长度等于实际帧数（第 19 帧是触发收官的那一帧，包含在内，不多不少）',
  );
  eq(
    buffer.snapshot().length,
    0,
    'J6 收官后缓冲区已清空（不会把上一段重复提交）',
  );

  // 紧接第二段：必须能重新开、且只收自己那一段
  enqueued.length = 0;
  const second = feedFrames(buffer, [...Array(5).fill(1200), ...Array(9).fill(5)]);
  eq(second.finishes, 1, 'J7 第二段也能收官');
  eq(enqueued.length, 1, 'J8 第二段只提交一次');
  eq(enqueued[0]?.length, 14 * FRAME_BYTES, 'J9 第二段长度只算自己的 14 帧');

  // 短噪声（2 帧）+ 长静音 → 丢弃，且不提交任何音频
  enqueued.length = 0;
  const noise = new SegmentBuffer(CFG);
  const noiseResult = feedFrames(noise, [...Array(2).fill(1200), ...Array(20).fill(5)]);
  eq(noiseResult.finishes, 0, 'J10 短噪声不提交识别');
  eq(noiseResult.drops, 1, 'J11 短噪声整段丢弃');
  eq(enqueued.length, 0, 'J12 丢弃时 enqueue 一次都没被调用');
  eq(noise.snapshot().length, 0, 'J13 丢弃后缓冲区归零');

  // 长静音（60 秒）不进缓冲区
  const silent = new SegmentBuffer(CFG);
  for (let i = 0; i < 600; i += 1) silent.push(frame(), 5, TH, CFG.vadSilenceMs);
  eq(silent.snapshot().length, 0, 'J14 60 秒纯静音不累积任何音频');
  eq(silent.durationMs, 0, 'J15 静音不会算进分段时长');

  // 中途快照：只读，不打断累积
  const interim = new SegmentBuffer(CFG);
  for (let i = 0; i < 12; i += 1) interim.push(frame(), 1200, TH, CFG.vadSilenceMs);
  eq(interim.snapshot().length, 12 * FRAME_BYTES, 'J16 中途快照长度正确');
  eq(interim.info.speechChunks, 12, 'J17 中途快照不影响状态');
  for (let i = 0; i < 9; i += 1) interim.push(frame(), 5, TH, CFG.vadSilenceMs);
  ok(interim.info.speaking === false, 'J18 之后仍然能正常收官');
}

console.log('\n== K. 分段时长的真实口径（中途停顿不能被漏算） ==\n');
{
  /*
   * `speechChunks + silenceChunks` 会漏算「说话 → 短停 → 又说话」里的那次短停，
   * 于是一段话里停顿几次，标称 12 秒的上限就晚触发几帧 —— 段变长、缓存变大、
   * 识别也更容易超时。这里用一个「抖动的长句」把它量化出来。
   */
  let state = { ...segment.EMPTY_SEGMENT };
  let frames = 0;
  let finished = null;
  // 每 6 帧响 + 2 帧停，循环到触发 max-duration
  for (let i = 0; i < 400; i += 1) {
    const rms = i % 8 < 6 ? 1200 : 30;
    const decision = feed(state, rms);
    state = decision.next;
    frames += 1;
    if (decision.action === 'finish' || decision.action === 'drop') {
      finished = { frames, reason: decision.reason };
      break;
    }
  }
  ok(Boolean(finished), 'K1 抖动长句最终会收官（不会无限增长）');
  const expected = CFG.maxSegmentMs / CFG.chunkMs;
  eq(finished?.frames, expected, `K2 恰好在 ${expected} 帧（12 秒）触发，不再被停顿拖晚`);
  eq(finished?.reason, 'max-duration', 'K3 收官原因是时长上限');

  /*
   * 反向对照：旧口径 `speechChunks + silenceChunks` 在**同一帧序号**上算出什么。
   *
   * 关键是要在同一时刻比较：跑到新口径收官的那一帧就停，看旧口径那一刻报多少。
   * （之前的写法没有在收官帧 break，oldCount 一路累加到 400 帧，反而比新口径更大，
   *   断言方向就反了 —— 那是测试代码的 bug，不是产品代码的。）
   *
   * 序列是「6 帧响 + 2 帧停」循环。每段停顿之后重新开口，旧口径的 silenceChunks
   * 就被清零，之前停的那 2 帧从此不再被计入：最终 speech 累加到 6k，silence 只剩
   * 最后那 2 帧。所以帧跑得越多，旧口径少算得越多。
   */
  const oldMsAtFrame = (targetFrames) => {
    let speech = 0;
    let silence = 0;
    let started = false;
    for (let i = 0; i < targetFrames; i += 1) {
      const rms = i % 8 < 6 ? 1200 : 30;
      const active = started ? rms > TH.keep : rms > TH.start;
      if (!started) {
        if (!active) continue;
        started = true;
        speech = 1;
        silence = 0;
        continue;
      }
      if (active) {
        speech += 1;
        silence = 0;
      } else {
        silence += 1;
      }
    }
    return (speech + silence) * CFG.chunkMs;
  };

  const frameAtNewTrigger = finished?.frames ?? 0;
  const oldMs = oldMsAtFrame(frameAtNewTrigger);
  ok(
    oldMs < CFG.maxSegmentMs,
    'K4 新口径该收官的同一帧上，旧口径算出的时长明显偏小（这就是上限晚触发的原因）',
    `旧 ${oldMs}ms vs 新 ${frameAtNewTrigger * CFG.chunkMs}ms（第 ${frameAtNewTrigger} 帧）`,
  );

  // 旧口径要跑到多少帧才认为自己到 12 秒 —— 差值就是「晚触发」的量化证据
  let oldFramesNeeded = 0;
  for (let n = frameAtNewTrigger; n <= 400; n += 1) {
    if (oldMsAtFrame(n) >= CFG.maxSegmentMs) {
      oldFramesNeeded = n;
      break;
    }
  }
  ok(
    oldFramesNeeded > frameAtNewTrigger,
    'K5 旧口径要多跑若干帧才触发上限（段变长、缓存变大、识别更容易超时）',
    `旧 ${oldFramesNeeded} 帧（${(oldFramesNeeded * CFG.chunkMs) / 1000}s） vs 新 ${frameAtNewTrigger} 帧（${(frameAtNewTrigger * CFG.chunkMs) / 1000}s）`,
  );
}

console.log('\n== L. 关键事实：规则提取与校验 ==\n');
{
  const facts = require('../dist/shared/facts.js');

  // 用户给的例子：明天下午三点开会，记得带材料
  const zh = facts.extractFactsWithRules({
    originalText: 'Let us meet tomorrow at 3 pm, and remember to bring the materials.',
    translatedText: '明天下午三点开会，记得带材料。',
  });
  const kinds = zh.map((item) => item.kind);
  ok(kinds.includes('date'), 'L1 认出日期', JSON.stringify(kinds));
  ok(kinds.includes('time'), 'L2 认出时间', JSON.stringify(kinds));
  ok(
    zh.some((item) => item.value.includes('明天')),
    'L3 相对时间保留原样（不换算成具体日期）',
    JSON.stringify(zh.map((i) => i.value)),
  );

  // 金额与数量
  const money = facts.extractFactsWithRules({
    originalText: 'It costs 120 dollars for 3 people.',
    translatedText: '三个人一共 120 美元。',
  });
  ok(
    money.some((item) => item.kind === 'money' && item.value.includes('120')),
    'L4 认出金额',
    JSON.stringify(money.map((i) => `${i.kind}:${i.value}`)),
  );
  ok(
    money.some((item) => item.kind === 'quantity'),
    'L5 认出数量',
    JSON.stringify(money.map((i) => `${i.kind}:${i.value}`)),
  );

  // 模糊语气 → uncertain（「可能周五」不能变「确定周五」）
  const hedged = facts.extractFactsWithRules({
    originalText: 'Maybe Friday works for the meeting.',
    translatedText: '可能周五开会。',
  });
  ok(hedged.length > 0, 'L6 模糊句也能提取（但状态不同）');
  ok(
    hedged.every((item) => item.certainty === 'uncertain'),
    'L7 带「可能」的整条标为 uncertain（不升格成确定）',
    JSON.stringify(hedged.map((i) => i.certainty)),
  );

  // 更正句式
  const corrected = facts.extractFactsWithRules({
    originalText: 'Not 3 pm, but 4 pm.',
    translatedText: '不是三点，是四点。',
  });
  ok(
    corrected.some((item) => item.certainty === 'corrected'),
    'L8 更正句式标成 corrected',
    JSON.stringify(corrected.map((i) => `${i.value}/${i.certainty}`)),
  );

  // 校验：来源必须能在字幕里找到
  const source = {
    itemId: 'it-1',
    originalText: 'Meet at the north gate at 3 pm.',
    translatedText: '下午三点在北门见。',
    roundIndex: 2,
  };
  const kept = facts.validateFacts(
    [
      { kind: 'time', value: '三点', sourceText: '3 pm', certainty: 'stated' },
      // 幻觉：原话里根本没有这句
      { kind: 'place', value: '南门', sourceText: 'south gate', certainty: 'stated' },
      // 类型不认识
      { kind: 'emotion', value: '开心', sourceText: '3 pm' },
      // 空值
      { kind: 'time', value: '', sourceText: '3 pm' },
      // 超长
      { kind: 'task', value: 'x'.repeat(200), sourceText: '3 pm' },
    ],
    source,
    (index) => `t-${index}`,
  );
  eq(kept.length, 1, 'L9 只有「出处对得上」的那条能留下');
  eq(kept[0]?.kind, 'time', 'L10 留下的是时间');
  eq(kept[0]?.sourceField, 'original', 'L11 记下片段取自原话');
  eq(kept[0]?.roundIndex, 2, 'L12 带上来源轮次');
  eq(kept[0]?.status, 'pending', 'L13 新事实默认待确认');

  // 同一句里重复的事实只留一条
  const dup = facts.validateFacts(
    [
      { kind: 'time', value: '三点', sourceText: '3 pm', certainty: 'stated' },
      { kind: 'time', value: '三点', sourceText: 'at 3 pm', certainty: 'stated' },
    ],
    source,
    (index) => `d-${index}`,
  );
  eq(dup.length, 1, 'L14 重复事实去重');

  // 译文里的片段也要能认（sourceField = translation）
  const fromTranslation = facts.validateFacts(
    [{ kind: 'place', value: '北门', sourceText: '北门', certainty: 'stated' }],
    source,
    (index) => `p-${index}`,
  );
  eq(fromTranslation[0]?.sourceField, 'translation', 'L15 出自译文的片段单独标注');

  // 状态词：有疑问是「待核对」，不给百分比
  const pending = { ...kept[0], status: 'pending', certainty: 'uncertain' };
  eq(facts.factStatusLabel(pending), '待核对', 'L16 有疑问显示待核对');
  eq(facts.factStatusLabel({ ...pending, status: 'confirmed' }), '已确认', 'L17 确认后');
  ok(!facts.factStatusLabel(pending).includes('%'), 'L18 不显示任何置信度百分比');

  // 确认句不得引入事实之外的新数字
  ok(
    facts.introducesNewNumbers('I confirm 4 people at the north gate.', facts.factsForConfirm([kept[0]])),
    'L19 句子里出现事实之外的数字 → 判定为新增信息',
  );
  // 原话里本来就有的数字不算「新信息」：factsForConfirm 现在会带出处。
  ok(
    !facts.introducesNewNumbers('I confirm 3 pm.', facts.factsForConfirm([kept[0]])),
    'L19b 沿用原话里的数字 → 放行',
  );
  // 改过的事实由更严的一道闸兜住（旧值不许留、新值不许漏）。
  ok(
    !facts.checkSentenceAgainstFacts('Just to confirm, 15,000 dollars.', '我理解的是16000美元，对吗？', [
      { value: '16000美元', sourceText: '15,000 dollars', edited: true, originalValue: '15000美元' },
    ]).ok,
    'L19c 改了值却还念旧值 → 拦下',
  );
  ok(
    !facts.introducesNewNumbers('我确认一下，是三点，对吗？', '时间：三点'),
    'L20 只用事实里的数字 → 放行',
  );

  /*
   * L21–L24：双语同一件事必须合成一条。
   *
   * 不合并时界面会出现
   *     日期  明天     「明天」
   *     日期  Tomorrow 「Tomorrow」
   * 同一件事两行，而且中文那行的「原文片段」还是中文 —— 等于外语原文没露出来。
   * 合并后：值取译文（中文可读），片段取原文（能核对对方原话）。
   */
  const bilingual = facts.extractFactsWithRules({
    originalText: 'Tomorrow at 3 pm we have a meeting.',
    translatedText: '明天下午三点我们开会。',
  });
  const dateRows = bilingual.filter((d) => d.kind === 'date');
  eq(dateRows.length, 1, 'L21 同一天只留一条（不再同时出现「明天」和「Tomorrow」）');
  eq(dateRows[0]?.value, '明天', 'L22 值取译文，中文可读');
  eq(dateRows[0]?.sourceText, 'Tomorrow', 'L23 原文片段取外语原话');
  eq(
    bilingual.filter((d) => d.kind === 'time').length,
    1,
    'L24 时间同样只留一条',
  );
  // 只有译文、没有原文对应时，原样保留（不硬凑成外语片段）
  const zhOnly = facts.extractFactsWithRules({
    originalText: 'See you there.',
    translatedText: '明天下午三点见。',
  });
  const zhDate = zhOnly.find((d) => d.kind === 'date');
  eq(zhDate?.value, '明天', 'L25 只有译文有日期时照样提取');
  eq(zhDate?.sourceText, '明天', 'L26 没有外语原文时片段就用译文原文，不编造');
}

console.log(
  failed === 0 ? `\nRESULT PASS ${total}/${total}` : `\nRESULT FAIL ${failed}/${total}`,
);
process.exit(failed === 0 ? 0 : 1);
