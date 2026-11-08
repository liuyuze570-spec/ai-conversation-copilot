import { env, pipeline } from '@xenova/transformers';
env.remoteHost = 'https://hf-mirror.com';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.cacheDir = './models';
env.allowRemoteModels = true;
env.allowLocalModels = true;
const t0 = Date.now();
const asr = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { quantized: true });
console.log('whisper loaded ms', Date.now() - t0);
const { readFileSync } = await import('node:fs');
const buf = readFileSync('../server/testdata/s4-new.wav');
// 解析 PCM16 WAV → Float32
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 12; let fmt = null; let data = null;
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4); const size = dv.getUint32(off + 4, true);
  if (id === 'fmt ') fmt = { channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
  if (id === 'data') { data = { start: off + 8, size }; break; }
  off += 8 + size + (size % 2);
}
console.log('fmt', fmt, 'data', data.size);
const samples = new Float32Array(data.size / 2);
for (let i = 0; i < samples.length; i += 1) samples[i] = dv.getInt16(data.start + i * 2, true) / 32768;
const t1 = Date.now();
const out = await asr(samples, { language: 'english', task: 'transcribe' });
console.log('asr ms', Date.now() - t1, '|', out.text);
