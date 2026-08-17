/* Layout-region analysis for the visual pass — audit helper, not app code.
   Reuses the PNG decoder from .audit-png-stats.mjs to extract design
   evidence that a pixel-statistics summary cannot: horizontal banding
   (header/content/footer), card geometry (via whitespace-gap detection),
   left-edge alignment of content columns, and per-region color. */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`colorType ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  const bpp = channels;
  let prev = Buffer.alloc(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = raw.subarray(src, src + stride);
    src += stride;
    const dst = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          v = (v + pred) & 0xff; break;
        }
        default: throw new Error(`filter ${filter}`);
      }
      dst[x] = v;
    }
    prev = dst;
  }
  return { width, height, channels, data: out };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const isBg = (r, g, b, bgLum) => Math.abs(lum(r, g, b) - bgLum) < 12;

function analyze(file) {
  const { width, height, channels, data } = decodePng(readFileSync(file));
  const px = (r, g, b) => data[((r * width + g) * channels)];
  const at = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };

  // 1) Background luminance: sample the four corners + edges; assume uniform bg.
  const corners = [at(2, 2), at(width - 3, 2), at(2, height - 3), at(width - 3, height - 3)]
    .map(([r, g, b]) => lum(r, g, b));
  const bgLum = corners.reduce((a, b) => a + b, 0) / corners.length;

  // 2) Row profile: for each row, what fraction is background vs content?
  //    Content = pixels differing from bg. Gives banding.
  const rowStride = Math.max(1, Math.floor(height / 240));
  const rows = [];
  for (let y = 0; y < height; y += rowStride) {
    let content = 0, total = 0;
    for (let x = 0; x < width; x += 4) {
      const [r, g, b] = at(x, y);
      total++;
      if (!isBg(r, g, b, bgLum)) content++;
    }
    rows.push({ y, contentFrac: content / total });
  }

  // 3) Find bands: contiguous regions of similar contentFrac.
  const bands = [];
  let cur = { start: rows[0].y, frac: rows[0].contentFrac, ys: [rows[0].y] };
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i].contentFrac - cur.frac) < 0.12) {
      cur.ys.push(rows[i].y);
      cur.frac = (cur.frac * (cur.ys.length - 1) + rows[i].contentFrac) / cur.ys.length;
    } else {
      bands.push({ start: cur.start, end: cur.ys[cur.ys.length - 1], frac: +cur.frac.toFixed(2) });
      cur = { start: rows[i].y, frac: rows[i].contentFrac, ys: [rows[i].y] };
    }
  }
  bands.push({ start: cur.start, end: cur.ys[cur.ys.length - 1], frac: +cur.frac.toFixed(2) });

  // 4) Left-edge alignment: for the main content region (skip header band if
  //    it's dense), find x positions where a content edge starts.
  const midY = Math.floor(height * 0.5);
  const colEdges = [];
  for (let y = Math.floor(height * 0.25); y < height * 0.85; y += 3) {
    let prevContent = false;
    for (let x = 0; x < width; x += 2) {
      const [r, g, b] = at(x, y);
      const isC = !isBg(r, g, b, bgLum);
      if (isC && !prevContent) colEdges.push({ x, y });
      prevContent = isC;
    }
  }
  // Histogram of edge x-positions — strong peaks = aligned columns.
  const edgeHist = new Map();
  for (const e of colEdges) {
    const k = Math.floor(e.x / 8) * 8;
    edgeHist.set(k, (edgeHist.get(k) || 0) + 1);
  }
  const topEdges = [...edgeHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([x, c]) => `${x}px(${c})`);

  // 5) Card detection: look for horizontal whitespace gutters (rows ~0% content)
  //    that separate stacked cards. Report the count of distinct content blocks.
  const contentRows = rows.filter(r => r.contentFrac > 0.15).length;
  const whitespaceRows = rows.filter(r => r.contentFrac <= 0.12).length;

  // 6) Color harmony: dominant colors in the content (non-bg) pixels.
  const colorCounts = new Map();
  let n = 0;
  const step = Math.max(channels, Math.floor((width * height) / 40000) * channels) || channels;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x += 3) {
      const [r, g, b] = at(x, y);
      if (isBg(r, g, b, bgLum)) continue;
      const key = ((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5);
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
      n++;
    }
  }
  const topColors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, c]) => {
      const r = ((k >> 10) & 31) * 8, g = ((k >> 5) & 31) * 8, b = (k & 31) * 8;
      return `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}:${((c / n) * 100).toFixed(1)}%`;
    });

  return {
    file: file.split(/[\\/]/).pop(),
    size: `${width}x${height}`,
    bgLum: +bgLum.toFixed(0),
    bands: bands.map(b => `${Math.round(b.start)}-${Math.round(b.end)}:${Math.round(b.frac * 100)}%`).join(' '),
    topEdges: topEdges.join(' '),
    whitespaceRows: `${whitespaceRows}/${rows.length}`,
  };
}

const files = process.argv.slice(2);
for (const f of files) {
  try { console.log(JSON.stringify(analyze(f), null, 2)); }
  catch (e) { console.log(JSON.stringify({ file: f, error: e.message }, null, 2)); }
}
