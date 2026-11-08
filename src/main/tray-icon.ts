import zlib from 'node:zlib';
import { nativeImage } from 'electron';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Builds a 32x32 tray icon in memory (rounded blue tile + white speech dot)
 * so the project does not need a binary icon asset to ship.
 */
export function createTrayIcon() {
  const size = 32;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const radius = 7;

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // PNG filter: none
    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 4;
      // rounded-corner mask
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const inside =
        dx >= radius || dy >= radius || (radius - dx) ** 2 + (radius - dy) ** 2 <= radius ** 2;

      // white "..." speech dots
      const dotRow = y >= 14 && y <= 18;
      const dot =
        dotRow && ((x >= 7 && x <= 10) || (x >= 14 && x <= 17) || (x >= 21 && x <= 24));

      if (!inside) {
        raw[offset] = 0;
        raw[offset + 1] = 0;
        raw[offset + 2] = 0;
        raw[offset + 3] = 0;
      } else if (dot) {
        raw[offset] = 255;
        raw[offset + 1] = 255;
        raw[offset + 2] = 255;
        raw[offset + 3] = 255;
      } else {
        raw[offset] = 0x5b;
        raw[offset + 1] = 0x8c;
        raw[offset + 2] = 0xff;
        raw[offset + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  return nativeImage.createFromBuffer(png);
}
