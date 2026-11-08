import { env, pipeline } from '@xenova/transformers';
env.remoteHost = 'https://hf-mirror.com';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.cacheDir = './models';
env.allowLocalModels = true;
const started = Date.now();
const translator = await pipeline('translation', 'Xenova/opus-mt-en-zh', { quantized: true });
console.log('load ms', Date.now() - started);
for (const text of [
  'Please send the report by 3 p.m. tomorrow.',
  'The meeting is not on Tuesday. It has moved to Thursday at 10:30 a.m.',
  'The budget is fifteen thousand, not fifty thousand.',
]) {
  const t = Date.now();
  const out = await translator(text);
  console.log((Date.now() - t) + 'ms', '|', out[0].translation_text);
}
