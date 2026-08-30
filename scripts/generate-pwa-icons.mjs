import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  }
  return current >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function blend(pixels, size, x, y, color, alpha = 1) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= size || py >= size) return;
  const offset = (py * size + px) * 4;
  const inverse = 1 - alpha;
  pixels[offset] = Math.round(color[0] * alpha + pixels[offset] * inverse);
  pixels[offset + 1] = Math.round(color[1] * alpha + pixels[offset + 1] * inverse);
  pixels[offset + 2] = Math.round(color[2] * alpha + pixels[offset + 2] * inverse);
  pixels[offset + 3] = 255;
}

function circle(pixels, size, centerX, centerY, radius, color, alpha = 1) {
  const minX = Math.floor(centerX - radius);
  const maxX = Math.ceil(centerX + radius);
  const minY = Math.floor(centerY - radius);
  const maxY = Math.ceil(centerY + radius);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance <= radius) {
        const edge = Math.min(1, radius - distance + 0.5);
        blend(pixels, size, x, y, color, alpha * edge);
      }
    }
  }
}

function line(pixels, size, from, to, width, color, alpha = 1) {
  const steps = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]));
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    circle(
      pixels,
      size,
      from[0] + (to[0] - from[0]) * ratio,
      from[1] + (to[1] - from[1]) * ratio,
      width / 2,
      color,
      alpha,
    );
  }
}

function rectangle(pixels, size, x, y, width, height, color) {
  for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
    for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) {
      blend(pixels, size, px, py, color);
    }
  }
}

function createIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const dark = [18, 53, 50];
  const light = [31, 79, 73];
  const lime = [220, 251, 127];
  const white = [244, 249, 243];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const glow = Math.max(0, 1 - Math.hypot(x - size * 0.2, y - size * 0.12) / size);
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(dark[channel] + (light[channel] - dark[channel]) * glow * 0.75);
      }
      pixels[offset + 3] = 255;
    }
  }

  circle(pixels, size, size * 0.85, size * 0.1, size * 0.28, lime, 0.08);
  circle(pixels, size, size * 0.06, size * 0.92, size * 0.34, white, 0.055);

  const points = [
    [size * 0.22, size * 0.28],
    [size * 0.36, size * 0.47],
    [size * 0.63, size * 0.4],
    [size * 0.77, size * 0.71],
  ];
  for (let index = 0; index < points.length - 1; index += 1) {
    line(pixels, size, points[index], points[index + 1], size * 0.035, white, 0.82);
  }
  for (const [x, y] of points) {
    circle(pixels, size, x, y, size * 0.055, lime);
    circle(pixels, size, x, y, size * 0.021, dark);
  }

  const plusX = size * 0.5;
  const plusY = size * 0.65;
  circle(pixels, size, plusX, plusY, size * 0.15, dark);
  circle(pixels, size, plusX, plusY, size * 0.135, lime);
  rectangle(pixels, size, plusX - size * 0.07, plusY - size * 0.022, size * 0.14, size * 0.044, dark);
  rectangle(pixels, size, plusX - size * 0.022, plusY - size * 0.07, size * 0.044, size * 0.14, dark);

  const scanlines = [];
  for (let y = 0; y < size; y += 1) {
    scanlines.push(Buffer.from([0]), pixels.subarray(y * size * 4, (y + 1) * size * 4));
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(scanlines), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await Promise.all([
  writeFile("public/icon-192.png", createIcon(192)),
  writeFile("public/icon-512.png", createIcon(512)),
  writeFile("public/apple-touch-icon.png", createIcon(180)),
]);
