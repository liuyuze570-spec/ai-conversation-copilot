/**
 * P2「翻译其他网页视频」的纯逻辑层。
 *
 * 这里只放**不碰 DOM / 不碰网络**的函数，理由有两个：
 * 1. 桌面端和网页端都能复用（`@shared` 别名）；
 * 2. 切片去重、断句、静音判定是最容易悄悄出错的地方，必须能在 Node 里单测，
 *    不能只靠「真浏览器跑一遍看着像对的」。
 *
 * 纪律：本文件不生成任何文字。识别不到就是空串，由界面显示「等待声音」，
 * 绝不用上一句、关键词或模板补一段假字幕出来。
 */

/** 比较用的规范化：小写、去标点、合并空白。中日韩文字按字符保留。 */
export function normalizeForDedupe(text: string): string {
  return (text || '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 不能以句点断句的词：缩写、敬称、以及 "12.5" 这类数字。 */
const NON_BREAKING_TOKENS = new Set([
  'p.m.', 'a.m.', 'pm.', 'am.', 'mr.', 'mrs.', 'ms.', 'dr.', 'prof.',
  'st.', 'vs.', 'etc.', 'e.g.', 'i.e.', 'no.', 'inc.', 'ltd.', 'u.s.',
]);

function endsSentence(token: string): boolean {
  if (!/[.!?]$/.test(token)) return false;
  if (NON_BREAKING_TOKENS.has(token.toLocaleLowerCase())) return false;
  // 小数 "12.5" 不以句点结尾，编号 "No." 已在白名单里；句末 "900." 必须能断句。
  // "J." 这类单字母缩写不当句末。
  if (/^[A-Za-z]\.$/.test(token)) return false;
  return true;
}

/**
 * 滑窗重叠裁剪：whisper 在相邻切片上常把上一句的尾巴再吐一遍。
 * 找「上一句尾部 k 个词 == 本句头部 k 个词」的最长 k，只保留本句剩余部分。
 * 至少 2 个词才算重叠，避免把正常的重复词（"the the"）误删。
 */
export function trimOverlap(previous: string, incoming: string): string {
  const text = (incoming || '').trim();
  const prevWords = normalizeForDedupe(previous).split(' ').filter(Boolean);
  const inWords = normalizeForDedupe(text).split(' ').filter(Boolean);
  if (prevWords.length < 2 || inWords.length < 2) return text;

  // 在「规范化后的词」上找最长公共尾/首。不能用原始词直接比：
  // "p.m." 规范化成 "p m"，两边词数不一致会永远匹配不上。
  let overlap = 0;
  const max = Math.min(prevWords.length, inWords.length);
  for (let k = max; k >= 2; k -= 1) {
    if (prevWords.slice(prevWords.length - k).join(' ') === inWords.slice(0, k).join(' ')) {
      overlap = k;
      break;
    }
  }
  if (!overlap) return text;

  // 把「规范化词数」映射回原始词边界，保留原文的标点与大小写。
  const rawWords = text.split(/\s+/).filter(Boolean);
  let normalizedSeen = 0;
  let cut = 0;
  for (let i = 0; i < rawWords.length; i += 1) {
    normalizedSeen += normalizeForDedupe(rawWords[i]).split(' ').filter(Boolean).length;
    if (normalizedSeen >= overlap) {
      cut = i + 1;
      break;
    }
  }
  return rawWords.slice(cut).join(' ').trim();
}

/** 与最近若干条字幕去重；完全相同或被重叠吃光的片段返回空串。 */
export function dedupeSegment(recent: string[], incoming: string): string {
  const text = (incoming || '').trim();
  if (!text) return '';
  const normalized = normalizeForDedupe(text);
  if (!normalized) return '';
  const pool = (recent || []).slice(-4);
  if (pool.some((old) => normalizeForDedupe(old) === normalized)) return '';
  let best = text;
  for (const old of pool) {
    const trimmed = trimOverlap(old, text);
    if (trimmed.length < best.length) best = trimmed;
  }
  return best;
}

export interface SentenceSplit {
  sentences: string[];
  /** 没等到句号的后半截，留给下一片继续拼。 */
  rest: string;
}

/**
 * 按词断句。`force=true` 时把整段缓冲作为一句收尾（停止采集 / 静音超时 / 超长）。
 * 没有句号的部分**不**出字幕，避免把半句当成一句翻译。
 */
export function splitSentences(buffer: string, force = false): SentenceSplit {
  const text = (buffer || '').trim();
  if (!text) return { sentences: [], rest: '' };
  if (force) return { sentences: [text], rest: '' };
  const tokens = text.split(/\s+/);
  const sentences: string[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    current.push(token);
    if (endsSentence(token)) {
      sentences.push(current.join(' ').trim());
      current = [];
    }
  }
  return { sentences, rest: current.join(' ').trim() };
}

/** 均方根音量。用于「无声音时等待，不凭空生成字幕」。 */
export function rmsOf(pcm: Float32Array): number {
  if (!pcm || pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

export function isSilent(pcm: Float32Array, threshold = 0.008): boolean {
  return rmsOf(pcm) < threshold;
}

/** 线性插值降采样。浏览器 AudioContext 常是 48kHz，识别只需 16kHz。 */
export function downsample(pcm: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (toRate >= fromRate || fromRate <= 0) return new Float32Array(pcm);
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.floor(pcm.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(pcm.length - 1, left + 1);
    const frac = pos - left;
    out[i] = pcm[left] * (1 - frac) + pcm[right] * frac;
  }
  return out;
}

/** 16-bit 单声道 PCM WAV。返回字节，调用方自己包 Blob（Node 单测不需要 Blob）。 */
export function pcmToWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);      // fmt chunk 长度
  view.setUint16(20, 1, true);      // PCM
  view.setUint16(22, 1, true);      // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);      // block align
  view.setUint16(34, 16, true);     // 位深
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

/** 从 WAV 字节里读时长（与后端 `_wav_seconds` 同一口径，便于单测对齐）。 */
export function wavSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteRate = view.getUint32(28, true);
  const dataSize = view.getUint32(40, true);
  if (!byteRate || !dataSize) return null;
  return dataSize / byteRate;
}

/** 延迟分位数（p 传 50 / 95）。空数组返回 0，不伪造数字。 */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * (p / 100);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
