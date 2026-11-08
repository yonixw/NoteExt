// Generates icons/icon{16,32,48,128}.png: three overlapping circles (Venn) with an "N" in front.
// Plain Node, no dependencies:  node tools/make-icons.js
// Not needed to run the extension - the PNGs are committed. Edit COLORS / geometry and re-run.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COLORS = [[255, 193, 7], [229, 57, 53], [30, 136, 229]]; // yellow, red, blue
const ALPHA = 0.78;
// Geometry in a 128x128 design space.
const CIRCLES = [[64, 45, 35], [44, 80, 35], [84, 80, 35]]; // cx, cy, r
const N_SHAPES = [ // convex polygons forming the letter N
  [[38, 34], [53, 34], [53, 96], [38, 96]], // left bar
  [[75, 34], [90, 34], [90, 96], [75, 96]], // right bar
  [[38, 34], [53, 34], [90, 96], [75, 96]], // diagonal
];
const OUTLINE = 4.5; // dark rim around the N, design px
const ZOOM = 1.1; // scale the whole artwork around the center (less empty padding)

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
// 0 inside the convex polygon, otherwise distance to it.
function distToPoly(px, py, poly) {
  let inside = true, sign = 0, d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross !== 0) {
      const s = Math.sign(cross);
      if (sign === 0) sign = s; else if (s !== sign) inside = false;
    }
    d = Math.min(d, distToSegment(px, py, ax, ay, bx, by));
  }
  return inside ? 0 : d;
}
const over = (dst, rgb, a) => { for (let k = 0; k < 3; k++) dst[k] = dst[k] * (1 - a) + rgb[k] * a; dst[3] = dst[3] + (1 - dst[3]) * a; };

// Color of one sample point (design coordinates) as [r, g, b, alpha 0..1], premultiplied-free.
function sample(x, y) {
  x = 64 + (x - 64) / ZOOM;
  y = 64 + (y - 64) / ZOOM;
  const c = [0, 0, 0, 0];
  CIRCLES.forEach(([cx, cy, r], i) => {
    if (Math.hypot(x - cx, y - cy) <= r) {
      if (c[3] === 0) { c[0] = COLORS[i][0]; c[1] = COLORS[i][1]; c[2] = COLORS[i][2]; c[3] = ALPHA; }
      else over(c, COLORS[i], ALPHA);
    }
  });
  const d = Math.min(...N_SHAPES.map((p) => distToPoly(x, y, p)));
  if (d === 0) { c[0] = c[1] = c[2] = 255; c[3] = 1; }
  else if (d <= OUTLINE) { c[0] = c[1] = c[2] = 26; c[3] = 1; }
  return c;
}

function render(size) {
  const SS = 6; // supersampling per axis
  const px = Buffer.alloc(size * size * 4);
  const scale = 128 / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = sample((x + (sx + 0.5) / SS) * scale, (y + (sy + 0.5) / SS) * scale);
      r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
    }
    const i = (y * size + x) * 4, n = SS * SS;
    px[i] = a ? Math.round(r / a) : 0;
    px[i + 1] = a ? Math.round(g / a) : 0;
    px[i + 2] = a ? Math.round(b / a) : 0;
    px[i + 3] = Math.round((a / n) * 255);
  }
  return png(size, size, px);
}

// ---- minimal PNG encoder (RGBA, no filtering) ----
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(out, `icon${s}.png`), render(s));
  console.log('wrote', `icons/icon${s}.png`);
}
