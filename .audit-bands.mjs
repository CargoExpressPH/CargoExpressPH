import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function decodePng(buf) {
  let pos = 8; let width=0, height=0, channels=0; const idat=[];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos+4, pos+8);
    const data = buf.subarray(pos+8, pos+8+len);
    if (type==='IHDR'){ width=data.readUInt32BE(0); height=data.readUInt32BE(4); channels={0:1,2:3,3:1,4:2,6:4}[data[9]]; }
    else if (type==='IDAT') idat.push(data);
    else if (type==='IEND') break;
    pos += 12+len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width*channels; const out = Buffer.alloc(width*height*channels);
  let prev = Buffer.alloc(stride); let src = 0;
  for (let y=0; y<height; y++) {
    const filter = raw[src++]; const row = raw.subarray(src, src+stride); src += stride;
    const dst = out.subarray(y*stride, (y+1)*stride);
    for (let x=0; x<stride; x++) {
      const a = x>=channels?dst[x-channels]:0, b=prev[x], c=x>=channels?prev[x-channels]:0;
      let v = row[x];
      if (filter===1) v=(v+a)&0xff; else if (filter===2) v=(v+b)&0xff; else if (filter===3) v=(v+((a+b)>>1))&0xff;
      else if (filter===4) { const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c); const pred=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c); v=(v+pred)&0xff; }
      dst[x]=v;
    }
    prev = dst;
  }
  return {width,height,channels,data:out};
}
const file = process.argv[2];
const {width,height,channels,data} = decodePng(readFileSync(file));
const at = (x,y) => { const i=(y*width+x)*channels; return [data[i],data[i+1],data[i+2]]; };
const lum = (r,g,b) => 0.2126*r+0.7152*g+0.0722*b;
const bgLum = [at(2,2),at(width-3,2),at(2,height-3),at(width-3,height-3)].map(c=>lum(...c)).reduce((a,b)=>a+b,0)/4;
// Split the page into N horizontal slices; report dominant colors + content density per slice.
const slices = Number(process.argv[3] || 8);
const sliceH = Math.floor(height / slices);
for (let s=0; s<slices; s++) {
  const y0 = s*sliceH, y1 = Math.min(height, y0+sliceH);
  const c = new Map(); let n=0, content=0;
  for (let y=y0; y<y1; y+=3) for (let x=0; x<width; x+=3) {
    const [r,g,b]=at(x,y); const L=lum(r,g,b);
    if (Math.abs(L-bgLum)>14) content++;
    const k=((r>>4)<<8)|((g>>4)<<4)|(b>>4); c.set(k,(c.get(k)||0)+1); n++;
  }
  const top=[...c.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>{
    const r=((k>>8)&15)*17,g=((k>>4)&15)*17,b=(k&15)*17;
    return r.toString(16).padStart(2,'0')+g.toString(16).padStart(2,'0')+b.toString(16).padStart(2,'0')+':'+((v/n)*100).toFixed(0)+'%';
  });
  console.log(`slice${s} y${y0}-${y1} content${(content/n*100).toFixed(0)}% -> ${top.join(' ')}`);
}
