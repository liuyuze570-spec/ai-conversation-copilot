/**
 * 录音转 WAV（16kHz 单声道 16bit）。
 *
 * 为什么非要转：浏览器录出来的是 `webm/opus`（Chrome）或 `mp4/aac`（Safari），
 * 服务端要解这两种就得装 ffmpeg。实测这台机器没有 ffmpeg，Node 侧也解不了 opus。
 * 而 WAV 是纯 PCM，任何语言都能读 —— 于是把「解码」放在浏览器（WebAudio 本来就会），
 * 后端只收 WAV。代价是上传体积变大（60 秒 16k 单声道约 1.9MB），在 8MB 限制内。
 */

export interface WavResult {
  blob: Blob;
  seconds: number;
  sampleRate: number;
}

export async function toWav(blob: Blob): Promise<WavResult> {
  const arrayBuffer = await blob.arrayBuffer();
  const Context = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Context();
  try {
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    const sampleRate = 16000;
    // 用 OfflineAudioContext 重采样到 16k，避免手写重采样算法引入噪声。
    const length = Math.max(1, Math.ceil(decoded.duration * sampleRate));
    const offline = new OfflineAudioContext(1, length, sampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const channel = rendered.getChannelData(0);
    const wav = encodeWav(channel, sampleRate);
    return { blob: wav, seconds: rendered.duration, sampleRate };
  } finally {
    void context.close();
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
