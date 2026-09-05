import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const sourceRoot = path.resolve(projectRoot, "..", "icons");
const outputDirectory = path.join(projectRoot, "build");
const outputFile = path.join(outputDirectory, "icon.ico");
const sources = [
  ["icon-16.png", 16],
  ["icon-32.png", 32],
  ["icon-48.png", 48],
  ["icon-128.png", 128],
];

const images = await Promise.all(sources.map(async ([name, size]) => ({
  bytes: await readFile(path.join(sourceRoot, name)),
  size,
})));

const source128 = PNG.sync.read(await readFile(path.join(sourceRoot, "icon-128.png")));
const icon256 = new PNG({ width: 256, height: 256 });
for (let y = 0; y < icon256.height; y += 1) {
  for (let x = 0; x < icon256.width; x += 1) {
    const sourceX = Math.floor((x * source128.width) / icon256.width);
    const sourceY = Math.floor((y * source128.height) / icon256.height);
    const sourceOffset = ((sourceY * source128.width) + sourceX) * 4;
    const targetOffset = ((y * icon256.width) + x) * 4;
    source128.data.copy(icon256.data, targetOffset, sourceOffset, sourceOffset + 4);
  }
}
images.push({ bytes: PNG.sync.write(icon256), size: 256 });

// Vista-and-newer Windows accepts PNG payloads inside an ICO container. Keeping
// the existing source sizes plus a Windows-required 256px layer produces a
// crisp taskbar, Explorer, and shell
// icon without introducing another image asset.
const directory = Buffer.alloc(6 + (16 * images.length));
directory.writeUInt16LE(0, 0);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);

let offset = directory.length;
for (const [index, image] of images.entries()) {
  const entry = 6 + (index * 16);
  directory.writeUInt8(image.size === 256 ? 0 : image.size, entry);
  directory.writeUInt8(image.size === 256 ? 0 : image.size, entry + 1);
  directory.writeUInt8(0, entry + 2);
  directory.writeUInt8(0, entry + 3);
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.bytes.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.bytes.length;
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputFile, Buffer.concat([directory, ...images.map((image) => image.bytes)]));
