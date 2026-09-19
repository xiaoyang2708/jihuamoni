/* =========================================================================
 * make-icons.js —— 生成"加到桌面"用的图标
 *
 *   node tools/make-icons.js
 *
 * 不依赖任何第三方库：自己画像素、自己写 PNG。
 * 换配色改下面 TOP / BOTTOM，换图形改 CHECK。
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');

/* 香槟金，跟 :root 里的 --primary (#ab8752) 同一族 */
const TOP = [198, 160, 106];
const BOTTOM = [154, 120, 69];
const MARK = [255, 255, 255];

/* 对勾的三个折点，归一化坐标（0~1） */
const CHECK = [[0.255, 0.545], [0.425, 0.715], [0.755, 0.315]];
const THICKNESS = 0.088;

/* ---------------------------------------------------------------------
 * PNG 编码
 * ------------------------------------------------------------------- */

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 每通道 8 位
  ihdr[9] = 6;    // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;                                  // 过滤器：无
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------------
 * 画图
 * ------------------------------------------------------------------- */

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/* 圆角矩形的有符号距离：负数在形状内部 */
function sdRoundRect(px, py, size, r) {
  const half = size / 2;
  const dx = Math.abs(px - half) - (half - r);
  const dy = Math.abs(py - half) - (half - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToCheck(px, py, size, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSeg(px, py,
      pts[i][0] * size, pts[i][1] * size,
      pts[i + 1][0] * size, pts[i + 1][1] * size);
    if (d < best) best = d;
  }
  return best;
}

function colorAt(px, py, size) {
  const t = py / size;
  let r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
  let g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
  let b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;
  /* 左上角一点柔光，免得整块死板 */
  const dx = (px - size * 0.30) / size;
  const dy = (py - size * 0.20) / size;
  const glow = Math.max(0, 1 - Math.hypot(dx, dy) / 0.62);
  const add = glow * glow * 16;
  return [r + add, g + add, b + add];
}

function render(size, opts) {
  const corners = opts.corners ? 0.225 * size : 0;
  const thickness = size * opts.thickness;
  const aa = Math.max(0.9, size / 220);
  const pts = opts.scale
    ? CHECK.map(function (p) {
        return [0.5 + (p[0] - 0.5) * opts.scale, 0.5 + (p[1] - 0.5) * opts.scale];
      })
    : CHECK;

  const out = Buffer.alloc(size * size * 4);
  const SS = 3;                         // 每个像素 3×3 采样

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let aSum = 0, rSum = 0, gSum = 0, bSum = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;

          const shape = corners
            ? clamp01(0.5 - sdRoundRect(px, py, size, corners) / aa)
            : 1;
          if (shape <= 0) continue;

          const d = distToCheck(px, py, size, pts);
          const m = clamp01((thickness / 2 - d) / aa + 0.5);
          const base = colorAt(px, py, size);

          rSum += shape * (base[0] + (MARK[0] - base[0]) * m);
          gSum += shape * (base[1] + (MARK[1] - base[1]) * m);
          bSum += shape * (base[2] + (MARK[2] - base[2]) * m);
          aSum += shape;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const a = aSum / n;
      if (a <= 0) continue;
      /* 颜色按覆盖面积平均，再还原成非预乘的通道值 */
      out[i] = Math.round(clamp01(rSum / aSum / 255) * 255);
      out[i + 1] = Math.round(clamp01(gSum / aSum / 255) * 255);
      out[i + 2] = Math.round(clamp01(bSum / aSum / 255) * 255);
      out[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  return encodePNG(size, out);
}

/* ---------------------------------------------------------------------
 * 输出
 * ------------------------------------------------------------------- */

const JOBS = [
  /* iOS 自己的圆角由系统加，给方图 */
  { file: 'icon-180.png', size: 180, corners: false, thickness: THICKNESS },
  { file: 'icon-192.png', size: 192, corners: true, thickness: THICKNESS },
  { file: 'icon-512.png', size: 512, corners: true, thickness: THICKNESS },
  /* maskable：安卓会裁成各种形状，图案要缩进中间的安全区 */
  { file: 'icon-maskable-512.png', size: 512, corners: false, thickness: THICKNESS * 0.70, scale: 0.70 },
];

fs.mkdirSync(OUT, { recursive: true });
JOBS.forEach(function (job) {
  const buf = render(job.size, job);
  fs.writeFileSync(path.join(OUT, job.file), buf);
  console.log('  ' + job.file + '  ' + job.size + '×' + job.size + '  ' + buf.length + ' 字节');
});
console.log('图标已生成到 icons/');
