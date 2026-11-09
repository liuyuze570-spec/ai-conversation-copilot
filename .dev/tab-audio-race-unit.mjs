/**
 * 网页端「延迟授权竞态」回归（纯逻辑 / 模拟 MediaStream，不用真实浏览器录音）。
 *
 * 复现路径：选源弹窗还没选完时用户点停止、或离开页面（卸载先 dispose 再
 * stop），随后 getDisplayMedia 的授权 Promise 才返回。早期 start() 直接
 * attach，状态会从 requesting → stopping → stopped → capturing 倒回去，
 * 新取得的 audio/video 轨仍 live —— 等于在已卸载的组件上继续采集。
 *
 * 这里用 esbuild 在内存里把 tabAudio.ts 转成 CJS，注入 @shared/caption-pipeline
 * 与 ./api 的 stub，再 mock 全套浏览器 API。**不启动真实浏览器、不录任何声音**。
 *
 * 运行：node .dev/tab-audio-race-unit.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const source = readFileSync(
  new URL('../webapp/web/src/tabAudio.ts', import.meta.url),
  'utf8',
);
const { code } = esbuild.transformSync(source, {
  loader: 'ts',
  format: 'cjs',
  target: 'es2022',
});

const captionStub = {
  chunkForTranslation: () => ({ chunks: [], omitted: 0, oversized: 0 }),
  dedupeSegment: (_recent, text) => text,
  downsample: (pcm) => pcm,
  isSilent: () => true,
  pcmToWav: () => new Uint8Array(0),
  splitSentences: (text) => ({ sentences: [], rest: text }),
};
const apiStub = {
  transcribeSegment: async () => ({ text: '', mode: 'stub' }),
  translate: async () => ({ translation: '', mode: 'stub' }),
  withSession: async (fn) => fn(),
};

const fakeRequire = (id) => {
  if (id === '@shared/caption-pipeline') return captionStub;
  if (id === './api' || id.endsWith('/api')) return apiStub;
  return require(id);
};
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(fakeRequire, mod, mod.exports);
const { TabAudioSession } = mod.exports;

/* ------------------------------------------------------------------ */
/* 模拟 MediaStream / 浏览器 API                                        */
/* ------------------------------------------------------------------ */

function makeTrack(kind) {
  return {
    kind,
    readyState: 'live',
    stopped: false,
    stop() {
      this.readyState = 'ended';
      this.stopped = true;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function makeStream() {
  const tracks = [makeTrack('audio'), makeTrack('video')];
  return {
    tracks,
    getTracks: () => tracks.slice(),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  };
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.audioWorklet = { addModule: async () => {} };
    this.destination = {};
    this.closed = false;
  }
  async resume() {}
  async close() { this.closed = true; }
  createMediaStreamSource() { return { connect() {} }; }
  createGain() { return { gain: { value: 0 }, connect() {} }; }
}
class FakeAudioWorkletNode {
  constructor() { this.port = { onmessage: null }; }
  connect() {}
  disconnect() {}
}
class FakeMediaStream {
  constructor(tracks) { this.tracks = tracks; }
}

/** Node 21+ 的 navigator 是只读 getter，必须用 defineProperty 覆盖。 */
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value, configurable: true, writable: true,
  });
}

function installGlobals(getDisplayMedia) {
  setGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  setGlobal('window', { AudioContext: FakeAudioContext });
  setGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  setGlobal('MediaStream', FakeMediaStream);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeSession(states, errors) {
  return new TabAudioSession({
    onState: (state, detail) => states.push([state, detail]),
    onLine: () => {},
    onStats: () => {},
    onError: (code, message) => errors.push([code, message]),
    onTranscript: () => {},
    onPassage: () => {},
  });
}

const tick = () => Promise.resolve();

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail !== undefined ? `  →  ${JSON.stringify(detail)}` : ''}`);
}
const wasCapturing = (states) => states.some(([s]) => s === 'capturing');
const allStopped = (stream) => stream.tracks.every((t) => t.stopped === true);

/* ------------------------------------------------------------------ */
/* 1. 授权前停止                                                       */
/* ------------------------------------------------------------------ */
{
  const grant = deferred();
  installGlobals(() => grant.promise);
  const states = [];
  const errors = [];
  const session = makeSession(states, errors);
  const starting = session.start();
  await tick();
  await session.stop();
  const stream = makeStream();
  grant.resolve(stream);
  await starting;

  ok('A1 授权前停止：audio 轨被停', stream.tracks[0].stopped === true, stream.tracks[0]);
  ok('A2 授权前停止：video 轨也被停', stream.tracks[1].stopped === true, stream.tracks[1]);
  ok('A3 授权前停止：全部轨道都停干净', allStopped(stream), stream.tracks);
  ok('A4 授权前停止：从未进入 capturing', !wasCapturing(states), states);
  ok('A5 授权前停止：最后状态是 stopped', states.at(-1)?.[0] === 'stopped', states.at(-1));
}

/* ------------------------------------------------------------------ */
/* 2. 卸载顺序：先 dispose 再 stop                                     */
/* ------------------------------------------------------------------ */
{
  const grant = deferred();
  installGlobals(() => grant.promise);
  const states = [];
  const errors = [];
  const session = makeSession(states, errors);
  const starting = session.start();
  await tick();
  session.dispose();
  await session.stop();
  const stream = makeStream();
  grant.resolve(stream);
  await starting;

  ok('B1 卸载后授权返回：audio 轨被停', stream.tracks[0].stopped === true, stream.tracks[0]);
  ok('B2 卸载后授权返回：video 轨也被停', stream.tracks[1].stopped === true, stream.tracks[1]);
  ok('B3 卸载后授权返回：全部轨道都停干净', allStopped(stream), stream.tracks);
  ok('B4 卸载后授权返回：从未进入 capturing', !wasCapturing(states), states);
  ok('B5 卸载后授权返回：不往组件里报错', errors.length === 0, errors);
}

/* ------------------------------------------------------------------ */
/* 3. 只 dispose、没有 stop                                            */
/* ------------------------------------------------------------------ */
{
  const grant = deferred();
  installGlobals(() => grant.promise);
  const states = [];
  const errors = [];
  const session = makeSession(states, errors);
  const starting = session.start();
  await tick();
  session.dispose();
  const stream = makeStream();
  grant.resolve(stream);
  await starting;

  ok('C1 只 dispose：授权返回仍停掉全部轨道', allStopped(stream), stream.tracks);
  ok('C2 只 dispose：从未进入 capturing', !wasCapturing(states), states);
}

/* ------------------------------------------------------------------ */
/* 4. 授权后正常启动                                                   */
/* ------------------------------------------------------------------ */
{
  const grant = deferred();
  installGlobals(() => grant.promise);
  const states = [];
  const errors = [];
  const session = makeSession(states, errors);
  const starting = session.start();
  await tick();
  const stream = makeStream();
  grant.resolve(stream);
  await starting;

  ok('D1 正常启动：进入 capturing', wasCapturing(states), states);
  ok('D2 正常启动：audio 轨保持 live', stream.tracks[0].stopped === false, stream.tracks[0]);
  ok('D3 正常启动：video 轨保持 live（不读帧但要留着维持会话）', stream.tracks[1].readyState === 'live', stream.tracks[1]);
  ok('D4 正常启动：没有 error 状态', !states.some(([s]) => s === 'error'), states);
}

/* ------------------------------------------------------------------ */
/* 5. 重复点击（选源弹窗没关就又点了一次开始）                          */
/* ------------------------------------------------------------------ */
{
  const first = deferred();
  const second = deferred();
  let calls = 0;
  installGlobals(() => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  });
  const states = [];
  const errors = [];
  const session = makeSession(states, errors);
  const s1 = session.start();
  const s2 = session.start();
  await tick();
  const stream1 = makeStream();
  const stream2 = makeStream();
  first.resolve(stream1);
  second.resolve(stream2);
  await Promise.all([s1, s2]);

  ok('E1 重复点击：第一次授权取得的轨道全停', allStopped(stream1), stream1.tracks);
  ok('E2 重复点击：第二次授权正常进入 capturing', wasCapturing(states), states);
  ok('E3 重复点击：capturing 只出现一次', states.filter(([s]) => s === 'capturing').length === 1, states);
  ok('E4 重复点击：第二次的 audio 轨未被误停', stream2.tracks[0].stopped === false, stream2.tracks[0]);
}

/* ------------------------------------------------------------------ */
/* 6. 暂停 / 继续期间授权返回（pause/resume 不是取消）                  */
/* ------------------------------------------------------------------ */
{
  const grant = deferred();
  installGlobals(() => grant.promise);
  const states = [];
  const errors = [];
  const session = makeSession(states, errors);
  const starting = session.start();
  await tick();
  // requesting 阶段还没有 stream，pause/resume 是空操作，但绝不能被当成取消。
  await session.pause();
  session.resume();
  const stream = makeStream();
  grant.resolve(stream);
  await starting;

  ok('F1 暂停/继续不是取消：仍正常进入 capturing', wasCapturing(states), states);
  ok('F2 暂停/继续不是取消：audio 轨未被误停', stream.tracks[0].stopped === false, stream.tracks[0]);
  ok('F3 暂停/继续不是取消：video 轨仍 live', stream.tracks[1].readyState === 'live', stream.tracks[1]);
}

/* ------------------------------------------------------------------ */
/* 7. 卸载后授权失败：不往已卸载组件里 setState / 报错                  */
/* ------------------------------------------------------------------ */
{
  const grant = deferred();
  installGlobals(() => grant.promise);
  const states = [];
  const errors = [];
  const session = makeSession(states, errors);
  const starting = session.start();
  await tick();
  session.dispose();
  grant.reject(new Error('user closed the picker'));
  await starting;

  ok('G1 卸载后授权失败：不再报错', errors.length === 0, errors);
  ok('G2 卸载后授权失败：不出现 error 状态', !states.some(([s]) => s === 'error'), states);
}

/* ------------------------------------------------------------------ */
/* 8. 自检：把修复块换回「授权返回直接 attach」的旧版，同一场景必须被抓住  */
/* ------------------------------------------------------------------ */
{
  const legacySource = source.replace(
    /    if \(generation !== this\.generation \|\| this\.disposed\) \{\n[\s\S]*?\n    \}\n    await this\.attach\(stream, 'video-tab'\);/,
    "    await this.attach(stream, 'video-tab');",
  );
  ok(
    '自检：确实改写出了旧版代码',
    legacySource !== source &&
      !legacySource.includes('for (const track of stream.getTracks()) track.stop();'),
  );

  const { code: legacyCode } = esbuild.transformSync(legacySource, {
    loader: 'ts', format: 'cjs', target: 'es2022',
  });
  const legacyMod = { exports: {} };
  new Function('require', 'module', 'exports', legacyCode)(
    fakeRequire, legacyMod, legacyMod.exports,
  );
  const LegacySession = legacyMod.exports.TabAudioSession;

  const grant = deferred();
  installGlobals(() => grant.promise);
  const states = [];
  const session = new LegacySession({
    onState: (s) => states.push([s, '']),
    onLine: () => {},
    onStats: () => {},
    onError: () => {},
  });
  const starting = session.start();
  await tick();
  await session.stop();
  const stream = makeStream();
  grant.resolve(stream);
  await starting;

  // 旧版：停止后授权回来照样 attach → 状态倒回 capturing，新轨道仍 live。
  ok('自检：旧版会错误地进入 capturing（A4 断言不是摆设）', wasCapturing(states), states);
  ok('自检：旧版会留下 live 轨道（A1/A2 断言不是摆设）', !allStopped(stream), stream.tracks);
}

console.log(`\n[tab-audio-race] 通过 ${pass} 条，失败 ${failures.length} 条`);
if (failures.length) {
  for (const line of failures) console.log(`  ✗ ${line}`);
  process.exitCode = 1;
}
