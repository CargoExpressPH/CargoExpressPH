/* Pure-Node PNG pixel statistics — audit helper, not part of the app.
   Decodes non-interlaced 8-bit RGB/RGBA/gray PNGs and reports luminance
   distribution + dominant colors so dark/light theme correctness of the
   e2e screenshots can be verified by measurement, not by eye. */
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
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`colorType ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  const bpp = channels; // bytes per pixel for filter math
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

function analyze(file) {
  const { width, height, channels, data } = decodePng(readFileSync(file));
  // Sample every pixel is fine for 1440px shots (~1.3M px) but step for speed.
  const step = channels;
  const hist = new Array(16).fill(0); // 16 luminance buckets
  const colorCounts = new Map();
  let n = 0, sum = 0, dark = 0, light = 0;
  const px = Math.floor((width * height) / 9000) * channels || channels; // ~9k samples
  for (let i = 0; i + 2 < data.length; i += px) {
    const r = data[i], g = channels >= 3 ? data[i + 1] : r, b = channels >= 3 ? data[i + 2] : r;
    const L = lum(r, g, b);
    hist[Math.min(15, Math.floor(L / 16))]++;
    sum += L; n++;
    if (L < 64) dark++;
    if (L > 192) light++;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
  }
  const top = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, c]) => {
      const r = ((k >> 8) & 15) * 17, g = ((k >> 4) & 15) * 17, b = (k & 15) * 17;
      return `${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}:${((c / n) * 100).toFixed(1)}%`;
    });
  return {
    file: file.split(/[\\/]/).pop(),
    meanLum: (sum / n).toFixed(1),
    darkPct: ((dark / n) * 100).toFixed(1),
    lightPct: ((light / n) * 100).toFixed(1),
    topColors: top.join(' '),
  };
}

const files = process.argv.slice(2);
const results = [];
for (const f of files) {
  try { results.push(analyze(f)); }
  catch (e) { results.push({ file: f.split(/[\\/]/).pop(), error: e.message }); }
}
console.table(results);
