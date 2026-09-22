import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const ASSETS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
);
const CANONICAL_SIZE = 1024;
const ARTWORK_EDGE_TRIM_PX = 6;
const CANONICAL_MARGIN_LIMIT_PX = 12;
const ALPHA_FLOOR = 8;
const ALPHA_CHANNELS = 4;
const RGB_CHANNELS = 3;
const PNG_COLOR_TYPE_RGB = 2;
const PNG_COLOR_TYPE_RGBA = 6;
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_HEADER_BYTES = 12;

const ICON_JOBS = [
  { master: "icon.png", icns: "icon.icns" },
  { master: "icon-nightly.png", icns: "icon-nightly.icns" },
  { master: "icon-dev.png", icns: null },
];

const ICONSET_REPS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function pngAlphaBounds(path) {
  const bytes = readFileSync(path);
  const header = bytes.toString("ascii", 1, 4);
  if (header !== "PNG") {
    throw new Error(`${path} is not a PNG`);
  }
  let offset = PNG_SIGNATURE_BYTES;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const compressed = [];
  while (offset + PNG_CHUNK_HEADER_BYTES <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + PNG_CHUNK_HEADER_BYTES;
  }
  if (
    bitDepth !== 8 ||
    (colorType !== PNG_COLOR_TYPE_RGB && colorType !== PNG_COLOR_TYPE_RGBA)
  ) {
    throw new Error(`${path} must be an 8-bit RGB or RGBA PNG`);
  }
  const channels =
    colorType === PNG_COLOR_TYPE_RGBA ? ALPHA_CHANNELS : RGB_CHANNELS;
  if (channels === RGB_CHANNELS) {
    return {
      width,
      height,
      minX: 0,
      minY: 0,
      maxX: width - 1,
      maxY: height - 1,
    };
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous =
      y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous === null ? 0 : previous[x];
      const upLeft =
        previous === null || x < channels ? 0 : previous[x - channels];
      let value = line[x];
      if (filter === 1) {
        value += left;
      } else if (filter === 2) {
        value += up;
      } else if (filter === 3) {
        value += (left + up) >> 1;
      } else if (filter === 4) {
        const estimate = left + up - upLeft;
        const leftDistance = Math.abs(estimate - left);
        const upDistance = Math.abs(estimate - up);
        const upLeftDistance = Math.abs(estimate - upLeft);
        value +=
          leftDistance <= upDistance && leftDistance <= upLeftDistance
            ? left
            : upDistance <= upLeftDistance
              ? up
              : upLeft;
      }
      row[x] = value & 0xff;
    }
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (
        pixels[y * stride + x * channels + ALPHA_CHANNELS - 1] <= ALPHA_FLOOR
      ) {
        continue;
      }
      if (x < minX) {
        minX = x;
      }
      if (x > maxX) {
        maxX = x;
      }
      if (y < minY) {
        minY = y;
      }
      if (y > maxY) {
        maxY = y;
      }
    }
  }
  if (maxX < 0) {
    throw new Error(`${path} is fully transparent`);
  }
  return { width, height, minX, minY, maxX, maxY };
}

function run(command, args) {
  execFileSync(command, args, { stdio: ["ignore", "ignore", "inherit"] });
}

function resample(source, size, destination) {
  run("sips", ["-z", `${size}`, `${size}`, source, "--out", destination]);
}

function canonicalizeMaster(masterPath) {
  const bounds = pngAlphaBounds(masterPath);
  const margin = Math.min(
    bounds.minX,
    bounds.minY,
    bounds.width - 1 - bounds.maxX,
    bounds.height - 1 - bounds.maxY,
  );
  if (margin <= CANONICAL_MARGIN_LIMIT_PX) {
    return false;
  }
  const artwork = Math.min(
    bounds.maxX - bounds.minX + 1,
    bounds.maxY - bounds.minY + 1,
  );
  const trimmedPath = `${masterPath}.trimmed.png`;
  const cropSize = artwork - ARTWORK_EDGE_TRIM_PX * 2;
  run("sips", [
    "-c",
    `${cropSize}`,
    `${cropSize}`,
    "--cropOffset",
    `${bounds.minY + ARTWORK_EDGE_TRIM_PX}`,
    `${bounds.minX + ARTWORK_EDGE_TRIM_PX}`,
    masterPath,
    "--out",
    trimmedPath,
  ]);
  resample(trimmedPath, CANONICAL_SIZE, masterPath);
  rmSync(trimmedPath, { force: true });
  return true;
}

function writeIcns(masterPath, icnsPath) {
  const iconsetPath = `${icnsPath}.iconset`;
  rmSync(iconsetPath, { recursive: true, force: true });
  mkdirSync(iconsetPath, { recursive: true });
  for (const [fileName, size] of ICONSET_REPS) {
    resample(masterPath, size, join(iconsetPath, fileName));
  }
  run("iconutil", ["-c", "icns", iconsetPath, "-o", icnsPath]);
  rmSync(iconsetPath, { recursive: true, force: true });
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error(
      "generate-app-icon needs macOS: it drives sips and iconutil",
    );
  }
  for (const job of ICON_JOBS) {
    const masterPath = join(ASSETS_DIR, job.master);
    const canonicalized = canonicalizeMaster(masterPath);
    if (job.icns !== null) {
      writeIcns(masterPath, join(ASSETS_DIR, job.icns));
    }
    const state = canonicalized
      ? "composed to full-bleed"
      : "already full-bleed";
    process.stdout.write(
      `${job.master}: ${state}${job.icns === null ? "" : `, wrote ${job.icns}`}\n`,
    );
  }
}

main();
