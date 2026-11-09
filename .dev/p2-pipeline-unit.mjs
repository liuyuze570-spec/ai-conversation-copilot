/**
 * P2 持续字幕纯逻辑回归（2026-11-09）。
 *
 * 这里验的是「不会静默丢字、不会凭空造字」：
 *  - 静音片必须判为静音；
 *  - 重叠片必须裁掉重复前缀，完全重复必须丢；
 *  - 没有句号不能出句，p.m. / 小数不能被误当句末；
 *  - WAV 头里的时长必须和切片长度一致（后端按这个秒数扣预算）。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeForDedupe,
  trimOverlap,
  dedupeSegment,
  splitSentences,
  rmsOf,
  isSilent,
  downsample,
  pcmToWav,
  wavSeconds,
  percentile,
} = require('../dist/shared/caption-pipeline.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`FAIL ${name}${detail !== undefined ? `\n  got  ${JSON.stringify(detail)}` : ''}`);
  }
}

/* ---- 1. 规范化与去重 ------------------------------------------------- */
ok('N1 规范化去标点与大小写', normalizeForDedupe('  Hello,  HELLO! ') === 'hello hello');
ok('N2 空串规范化为空', normalizeForDedupe('') === '');
ok('D1 完全重复整段丢弃', dedupeSegment(['The deposit is 300.'], 'the deposit is 300!') === '');
ok('D2 滑窗重叠只保留新尾巴',
  trimOverlap('Please send the report by 3 p.m.', 'by 3 p.m. Tomorrow morning.') === 'Tomorrow morning.',
  trimOverlap('Please send the report by 3 p.m.', 'by 3 p.m. Tomorrow morning.'));
ok('D3 重叠后无剩余返回空',
  dedupeSegment(['We will meet at 4:20 p.m.'], 'at 4:20 p.m.') === '',
  dedupeSegment(['We will meet at 4:20 p.m.'], 'at 4:20 p.m.'));
ok('D4 不相关句子不被误删',
  dedupeSegment(['The deposit is 300.'], 'What currency is that?') === 'What currency is that?');
ok('D5 单词重复不当重叠',
  trimOverlap('the deposit is 300', 'the deposit is 900') === 'the deposit is 900',
  trimOverlap('the deposit is 300', 'the deposit is 900'));

/* ---- 2. 断句 --------------------------------------------------------- */
{
  const r = splitSentences('Please send the report by 3 p.m. tomorrow. The balance is 900.');
  ok('S1 两句', r.sentences.length === 2, r);
  ok('S2 p.m. 不误断', r.sentences[0].includes('3 p.m. tomorrow.'), r.sentences[0]);
  ok('S3 无剩余', r.rest === '', r.rest);
}
ok('S4 小数不误断', splitSentences('It costs 12.5 dollars.').sentences.length === 1);
ok('S5 没句号不出句', splitSentences('The meeting is on Friday afternoon').sentences.length === 0);
ok('S6 没句号保留 rest', splitSentences('The meeting is on Friday afternoon').rest === 'The meeting is on Friday afternoon');
ok('S7 force 收半句', splitSentences('The meeting is on Friday afternoon', true).sentences.length === 1);
ok('S8 空缓冲不造句', splitSentences('  ').sentences.length === 0 && splitSentences('  ', true).sentences.length === 0);
ok('S9 a.m. 不误断', splitSentences('Meet at 10:30 a.m. on Thursday.').sentences.length === 1);
ok('S10 问号叹号断句', splitSentences('Really? Yes! OK.').sentences.length === 3,
  splitSentences('Really? Yes! OK.').sentences);

/* ---- 3. 静音与 WAV --------------------------------------------------- */
{
  const silence = new Float32Array(16000);
  const tone = new Float32Array(16000);
  for (let i = 0; i < tone.length; i += 1) tone[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  ok('A1 全零是静音', isSilent(silence) && rmsOf(silence) === 0);
  ok('A2 正弦不是静音', !isSilent(tone));
  ok('A3 rms 约等于振幅/√2', Math.abs(rmsOf(tone) - 0.2 / Math.SQRT2) < 0.002, rmsOf(tone));

  const bytes = pcmToWav(tone, 16000);
  const head = String.fromCharCode(...bytes.slice(0, 4));
  const wave = String.fromCharCode(...bytes.slice(8, 12));
  ok('W1 RIFF/WAVE', head === 'RIFF' && wave === 'WAVE');
  ok('W2 长度 = 44 + 样本×2', bytes.length === 44 + 16000 * 2, bytes.length);
  ok('W3 时长 = 1 秒', Math.abs(wavSeconds(bytes) - 1) < 1e-9, wavSeconds(bytes));
  ok('W4 单声道 16bit', new DataView(bytes.buffer).getUint16(22, true) === 1 &&
    new DataView(bytes.buffer).getUint16(34, true) === 16);

  const half = pcmToWav(new Float32Array(8000), 16000);
  ok('W5 半秒切片时长 = 0.5', Math.abs(wavSeconds(half) - 0.5) < 1e-9, wavSeconds(half));
  ok('W6 太短字节返回 null', wavSeconds(new Uint8Array(10)) === null);

  const down = downsample(tone, 48000, 16000);
  ok('W7 48k→16k 长度除以 3', down.length === Math.floor(tone.length / 3), down.length);
  ok('W8 目标率不低于源率时原样返回', downsample(tone, 16000, 48000).length === tone.length);
}

/* ---- 4. 延迟统计 ----------------------------------------------------- */
ok('P1 空样本为 0（不编数字）', percentile([], 95) === 0);
ok('P2 p50', percentile([10, 20, 30, 40], 50) === 25, percentile([10, 20, 30, 40], 50));
ok('P3 单样本', percentile([123], 95) === 123);
ok('P4 p95 不超过最大值', percentile([5, 9, 100], 95) <= 100);

console.log(`p2-pipeline-unit: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
