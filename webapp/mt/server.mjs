/**
 * 本地英译中服务（Node 边车）。
 *
 * 为什么单独一个进程：Python 侧用 Argos 的包索引在 GitHub 上，这台机器访问不到；
 * 而 transformers.js 可以走 hf-mirror 把 ONNX 模型**提前**下载到本地，运行时
 * `allowRemoteModels = false` —— 断网也能翻，且不会偷偷下载。
 *
 * 接口（只监听 127.0.0.1，不暴露公网）：
 *   GET  /health      -> {ok, model, loaded, load_ms}
 *   GET  /model-info  -> {model, license, files:[{name,bytes,sha256}]}
 *   POST /translate   -> {translation, elapsed_ms, mode:"local-opus"}
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@xenova/transformers';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.COPILOT_MT_PORT || 8100);
const MODEL = process.env.COPILOT_MT_MODEL || 'Xenova/opus-mt-en-zh';

// 关键：只允许本地模型。缺文件时报错，不静默下载。
env.allowRemoteModels = process.env.COPILOT_MT_ALLOW_DOWNLOAD === '1';
env.allowLocalModels = true;
env.localModelPath = path.join(DIR, 'models') + path.sep;
env.cacheDir = path.join(DIR, 'models');
env.remoteHost = 'https://hf-mirror.com';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.useBrowserCache = false;

let translator = null;
let loadMs = 0;
let loading = null;

async function ensure() {
  if (translator) return translator;
  if (loading) return loading;
  loading = (async () => {
    const started = Date.now();
    translator = await pipeline('translation', MODEL, { quantized: true });
    loadMs = Date.now() - started;
    console.log(JSON.stringify({ event: 'model_loaded', model: MODEL, load_ms: loadMs }));
    return translator;
  })();
  return loading;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function modelInfo() {
  const root = path.join(DIR, 'models', MODEL);
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const buffer = fs.readFileSync(full);
        files.push({
          name: path.relative(root, full).replace(/\\/g, '/'),
          bytes: buffer.length,
          sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        });
      }
    }
  };
  walk(root);
  return {
    model: MODEL,
    // Opus-MT 是 CC-BY-4.0；transformers.js 的 ONNX 转换版同名许可。
    license: 'CC-BY-4.0 (Helsinki-NLP/opus-mt-en-zh)',
    path: root,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, model: MODEL, loaded: Boolean(translator), load_ms: loadMs });
  }
  if (req.method === 'GET' && req.url === '/model-info') {
    return json(res, 200, modelInfo());
  }
  if (req.method === 'POST' && req.url === '/translate') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) {
        return json(res, 413, { error: { code: 'TOO_LARGE' } });
      }
    }
    let text = '';
    try {
      text = String(JSON.parse(body).text || '').slice(0, 2000);
    } catch {
      return json(res, 400, { error: { code: 'BAD_REQUEST' } });
    }
    if (!text.trim()) return json(res, 400, { error: { code: 'BAD_REQUEST' } });
    try {
      const pipe = await ensure();
      const t0 = Date.now();
      const out = await pipe(text);
      const translation = String(out?.[0]?.translation_text ?? '').trim();
      if (!translation) return json(res, 502, { error: { code: 'EMPTY_OUTPUT' } });
      return json(res, 200, {
        translation,
        mode: 'local-opus',
        elapsed_ms: Date.now() - t0,
        total_ms: Date.now() - started,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 120) : 'unknown';
      console.error(JSON.stringify({ event: 'translate_failed', message }));
      return json(res, 503, { error: { code: 'MODEL_UNAVAILABLE', message } });
    }
  }
  return json(res, 404, { error: { code: 'NOT_FOUND' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'mt_listening', port: PORT, model: MODEL }));
  // 预热：首句请求不要等 800ms 加载。
  ensure().catch((error) => console.error('warmup failed', error.message));
});
