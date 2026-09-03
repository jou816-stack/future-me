'use strict';
// 產生 App 圖示與選單列圖示（純 Node，不用外部套件）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 超取樣繪圖：每個像素取 4x4 子樣本做抗鋸齒
function render(size, shader) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const c = shader((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      const n = S * S;
      const i = (y * size + x) * 4;
      if (a > 0) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
      buf[i + 3] = (a / n) * 255;
    }
  }
  return buf;
}

// 幾何工具（座標 0..1）
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const distToSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

// App 圖示：暖紙色底、深墨色信封、封口一枚小紅蠟印
function appIcon(x, y) {
  const bg = [0x1f, 0x2a, 0x2e]; // 深墨綠
  const paper = [0xf6, 0xf1, 0xe7];
  const wax = [0xb8, 0x4a, 0x3c];
  if (!inRoundRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.2)) return [0, 0, 0, 0];
  // 信封本體
  const ex0 = 0.2, ey0 = 0.3, ex1 = 0.8, ey1 = 0.72;
  const inEnv = inRoundRect(x, y, ex0, ey0, ex1, ey1, 0.03);
  if (inEnv) {
    // 封口 V 線
    const lw = 0.022;
    const d = Math.min(distToSeg(x, y, ex0, ey0, 0.5, 0.53), distToSeg(x, y, ex1, ey0, 0.5, 0.53));
    // 蠟印
    if (Math.hypot(x - 0.5, y - 0.53) < 0.055) return [...wax, 1];
    if (d < lw) return [...bg, 1];
    return [...paper, 1];
  }
  return [...bg, 1];
}

// 選單列圖示：黑色 template（只用 alpha），心形天燈線稿 + 底下一點火光
function trayIcon(x, y) {
  // 心形：用兩個圓 + 一個尖角的隱式函數（座標置中、上下略壓）
  const px = (x - 0.5) * 2.3, py = (0.44 - y) * 2.3 + 0.15;
  const heart = Math.pow(px * px + py * py - 1, 3) - px * px * py * py * py; // <0 在心內
  const scale = 1.25;
  const heartOuter = Math.pow((px * scale) ** 2 + (py * scale) ** 2 - 1, 3) - (px * scale) ** 2 * (py * scale) ** 3;
  const ring = heart <= 0 && heartOuter > 0; // 線稿：外心減去縮小的內心
  const flame = Math.hypot((x - 0.5) * 1.6, y - 0.83) < 0.07; // 底下的小火光
  return ring || flame ? [0, 0, 0, 1] : [0, 0, 0, 0];
}

const out = path.join(__dirname, 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'trayTemplate.png'), png(22, 22, render(22, trayIcon)));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), png(44, 44, render(44, trayIcon)));
console.log('icons written to', out);
