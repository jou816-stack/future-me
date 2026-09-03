'use strict';
// 自己畫的 App 圖示：全滿正方形（系統套圓角）、紫夜星空、手繪感信封、發光心形封蠟。輸出 assets/icon.png（1024x1024）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 編碼 ----------
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 雜訊（手繪紋理、線條抖動）----------
const hash = (x, y, s = 0) => { let h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return h - Math.floor(h); };
const smooth = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  const u = smooth(xf), v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, s = 0, oct = 4) { let v = 0, amp = 0.5, f = 1; for (let i = 0; i < oct; i++) { v += amp * vnoise(x * f, y * f, s + i); amp *= 0.5; f *= 2.1; } return v; }

// ---------- 幾何 ----------
const mix = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mixc = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
const distSeg = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay; const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); };
function sdRoundRect(x, y, cx, cy, hw, hh, r) { const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; }
// 心形：回傳 <0 在內
function heartSd(x, y, cx, cy, size) { const px = (x - cx) / size, py = -(y - cy) / size + 0.1; const v = Math.pow(px * px + py * py - 1, 3) - px * px * py * py * py; return v; }

// ---------- 色票（跟封面同一個世界）----------
const SKY_TOP = [0.16, 0.12, 0.30];
const SKY_MID = [0.27, 0.20, 0.44];
const SKY_BOTTOM = [0.50, 0.34, 0.52];
const PAPER = [0.96, 0.90, 0.78];
const PAPER_SHADE = [0.86, 0.76, 0.62];
const INK = [0.22, 0.13, 0.28];
const GOLD = [1.0, 0.72, 0.30];
const GOLD_LIGHT = [1.0, 0.92, 0.66];

// 信封位置
const E = { cx: 0.5, cy: 0.53, hw: 0.38, hh: 0.26, r: 0.02 };
const FLAP_Y = E.cy + 0.03; // 封口尖端
const SEAL = { x: 0.5, y: FLAP_Y, size: 0.075 };

function shade(x, y) {
  // 圓角方形遮罩（含柔和陰影）
  // 全滿正方形、不做圓角：macOS 26 會自己套系統的圓角遮罩，這樣才不會露出底板的白邊
  const aa = 1;

  // ---- 天空：漸層 + 筆觸紋理 ----
  const t = clamp((y - 0.1) / 0.8, 0, 1);
  let col = t < 0.55 ? mixc(SKY_TOP, SKY_MID, t / 0.55) : mixc(SKY_MID, SKY_BOTTOM, (t - 0.55) / 0.45);
  const stroke = fbm(x * 18, y * 5, 7) - 0.5; // 橫向筆觸
  const grain = fbm(x * 60, y * 60, 3, 3) - 0.5;
  col = col.map((c) => clamp(c * (1 + stroke * 0.22 + grain * 0.14), 0, 1));
  // 底部一抹暖粉（像封面的地平線）
  const warm = clamp((y - 0.62) / 0.3, 0, 1) * 0.35 * (0.6 + 0.4 * fbm(x * 6, y * 6, 11));
  col = mixc(col, [0.72, 0.42, 0.50], warm);

  // ---- 星星 ----
  let star = 0;
  for (const [cell, sz, seed] of [[0.055, 0.0022, 1], [0.09, 0.0034, 2]]) {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cxg = gx + i, cyg = gy + j;
      const h = hash(cxg, cyg, seed);
      if (h < 0.62) continue;
      const sx = (cxg + hash(cxg, cyg, seed + 10)) * cell, sy = (cyg + hash(cxg, cyg, seed + 20)) * cell;
      if (sy > 0.24 && Math.abs(sx - 0.5) < 0.42 && sy < 0.82) continue; // 信封附近少放
      const d = Math.hypot(x - sx, y - sy);
      const br = 0.5 + 0.5 * hash(cxg, cyg, seed + 30);
      star += br * clamp(1 - d / sz, 0, 1);
      if (h > 0.93) { // 四芒星
        const ax = Math.abs(x - sx), ay = Math.abs(y - sy);
        const cross = Math.min(ax, ay) < sz * 0.35 && Math.max(ax, ay) < sz * 3.2;
        if (cross) star += br * 0.7 * (1 - Math.max(ax, ay) / (sz * 3.2));
      }
    }
  }
  col = mixc(col, GOLD_LIGHT, clamp(star, 0, 1));

  // ---- 信封落影 ----
  const dsh = sdRoundRect(x, y + 0.03, E.cx, E.cy, E.hw, E.hh, E.r);
  col = mixc(col, [0.08, 0.05, 0.16], clamp(1 - dsh / 0.06, 0, 1) * 0.45);

  // ---- 信封（手繪：邊緣抖動、線寬變化）----
  const wob = (fbm(x * 9, y * 9, 21) - 0.5) * 0.014;
  const d = sdRoundRect(x, y, E.cx, E.cy, E.hw, E.hh, E.r) + wob;
  const lineW = 0.009 + (fbm(x * 30, y * 30, 33) - 0.5) * 0.005;
  const inside = d < 0;
  if (inside) {
    // 紙：米白 + 紙纖維 + 下緣稍暗
    let paper = mixc(PAPER, PAPER_SHADE, clamp((y - E.cy) / E.hh * 0.5 + 0.2, 0, 1) * 0.55);
    const fiber = fbm(x * 90, y * 90, 41, 3) - 0.5;
    paper = paper.map((c) => clamp(c * (1 + fiber * 0.10), 0, 1));
    // 封口三角（上半部）：稍亮一點
    const x0 = E.cx - E.hw, x1 = E.cx + E.hw, y0 = E.cy - E.hh;
    const flapL = distSeg(x, y, x0, y0, SEAL.x, FLAP_Y), flapR = distSeg(x, y, x1, y0, SEAL.x, FLAP_Y);
    const inFlap = y < y0 + (FLAP_Y - y0) * (1 - Math.abs(x - E.cx) / E.hw);
    if (inFlap) paper = mixc(paper, [1, 0.97, 0.90], 0.35);
    // 封口下方一道淡淡的陰影
    const flapEdge = Math.min(flapL, flapR);
    if (!inFlap) paper = mixc(paper, PAPER_SHADE, clamp(1 - flapEdge / 0.03, 0, 1) * 0.45);
    // 背面下方的 V 字（淡）
    const y1 = E.cy + E.hh;
    const backV = Math.min(distSeg(x, y, x0, y1, E.cx, E.cy + 0.05), distSeg(x, y, x1, y1, E.cx, E.cy + 0.05));
    paper = mixc(paper, INK, clamp(1 - (backV + wob * 0.6) / (lineW * 0.55), 0, 1) * 0.25);
    col = paper;
    // 封口 V 線（墨）
    const flapInk = clamp(1 - (flapEdge + wob * 0.8) / lineW, 0, 1);
    col = mixc(col, INK, flapInk * 0.9);
  }
  // 外框線（墨，寬度隨機）+ 第二道淡線（像草圖重描）
  const edge = clamp(1 - Math.abs(d) / lineW, 0, 1);
  col = mixc(col, INK, edge * 0.92);
  const d2 = d + 0.006 + (fbm(x * 12, y * 12, 55) - 0.5) * 0.01;
  const edge2 = clamp(1 - Math.abs(d2) / (lineW * 0.45), 0, 1);
  col = mixc(col, INK, edge2 * 0.28);

  // ---- 心形封蠟：發光 ----
  const sd = heartSd(x, y, SEAL.x, SEAL.y, SEAL.size);
  const glowD = Math.hypot(x - SEAL.x, (y - SEAL.y) * 1.05);
  col = mixc(col, GOLD, 0.55 * Math.exp(-(glowD * glowD) / (0.07 * 0.07 * 2)));
  col = mixc(col, GOLD_LIGHT, 0.25 * Math.exp(-(glowD * glowD) / (0.18 * 0.18 * 2)));
  if (sd < 0) {
    const inner = clamp(-sd * 1.2, 0, 1);
    let wax = mixc([0.95, 0.60, 0.22], GOLD_LIGHT, inner * 0.85);
    wax = wax.map((c) => clamp(c * (1 + (fbm(x * 70, y * 70, 66, 3) - 0.5) * 0.10), 0, 1));
    const hl = Math.hypot((x - (SEAL.x - 0.012)) * 1.2, y - (SEAL.y - 0.016));
    wax = mixc(wax, [1, 1, 0.96], clamp(1 - hl / 0.018, 0, 1) * 0.55);
    col = wax;
  }
  // 心形外圍一圈深色墨線（只畫在外側、細一點）
  const sealEdge = sd >= 0 ? clamp(1 - sd / 0.04, 0, 1) : clamp(1 + sd / 0.03, 0, 1) * 0.35;
  col = mixc(col, [0.45, 0.22, 0.10], sealEdge * 0.85);

  return [col[0], col[1], col[2], aa];
}

// ---------- 渲染（2x2 超取樣）----------
const size = 1024, S = 2;
const buf = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
      r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
    }
    const i = (y * size + x) * 4;
    if (a > 0) { buf[i] = (r / a) * 255; buf[i + 1] = (g / a) * 255; buf[i + 2] = (b / a) * 255; }
    buf[i + 3] = (a / (S * S)) * 255;
  }
}
const out = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(out, png(size, size, buf));
console.log('wrote', out);
