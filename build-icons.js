/* build-icons.js — generates app icons with zero dependencies (node core only).
   Run:  node build-icons.js
   Produces: icon-180.png, icon-192.png, icon-512.png, icon-512-maskable.png, icon.svg
   Mark: dark tile, accent rounded square, white ring + offset dot (a coin / target). */
const fs = require("fs");
const zlib = require("zlib");

const COL = {
  bg:   [0x0b, 0x0d, 0x10],
  tile: [0x4f, 0x8c, 0xff],
  white:[0xf4, 0xf6, 0xf8],
};

function crc32(buf){
  let c = ~0;
  for (let i = 0; i < buf.length; i++){
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(width, height, rgba){
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++){
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function draw(size, { bleed = false } = {}){
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const ia = a / 255, na = 1 - ia;
    buf[i]   = Math.round(buf[i]   * na + r * ia);
    buf[i+1] = Math.round(buf[i+1] * na + g * ia);
    buf[i+2] = Math.round(buf[i+2] * na + b * ia);
    buf[i+3] = 255;
  };
  // background
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, COL.bg);

  const c = size / 2;
  // rounded-square tile
  const tileHalf = size * (bleed ? 0.5 : 0.34);
  const rad = size * (bleed ? 0.0 : 0.14);
  const inRounded = (x, y, half, r) => {
    const dx = Math.abs(x - c) - (half - r);
    const dy = Math.abs(y - c) - (half - r);
    if (dx <= 0 && dy <= 0) return true;
    const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
    return ax * ax + ay * ay <= r * r;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++){
      // supersample edges 3x3
      let hit = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++)
        if (inRounded(x + sx/3 - 1/3, y + sy/3 - 1/3, tileHalf, rad)) hit++;
      if (hit) put(x, y, COL.tile, Math.round(255 * hit / 9));
    }

  // white ring
  const ringR = size * 0.20, ringW = size * 0.052;
  const dotR = size * 0.072, dotCx = c + size * 0.135, dotCy = c + size * 0.135;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++){
      let ring = 0, dot = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++){
        const px = x + sx/3 - 1/3, py = y + sy/3 - 1/3;
        const d = Math.hypot(px - c, py - c);
        if (Math.abs(d - ringR) <= ringW / 2) ring++;
        if (Math.hypot(px - dotCx, py - dotCy) <= dotR) dot++;
      }
      if (ring) put(x, y, COL.white, Math.round(255 * ring / 9));
      if (dot)  put(x, y, COL.white, Math.round(255 * dot / 9));
    }
  return png(size, size, buf);
}

fs.writeFileSync("icon-180.png", draw(180));
fs.writeFileSync("icon-192.png", draw(192));
fs.writeFileSync("icon-512.png", draw(512));
fs.writeFileSync("icon-512-maskable.png", draw(512, { bleed: true }));
fs.writeFileSync("icon.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
<rect width="512" height="512" fill="#0b0d10"/>
<rect x="82" y="82" width="348" height="348" rx="72" fill="#4f8cff"/>
<circle cx="256" cy="256" r="102" fill="none" stroke="#f4f6f8" stroke-width="27"/>
<circle cx="325" cy="325" r="37" fill="#f4f6f8"/>
</svg>\n`);
console.log("icons written:", ["icon-180.png","icon-192.png","icon-512.png","icon-512-maskable.png","icon.svg"].join(", "));
