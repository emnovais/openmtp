import { promises as fs } from 'fs';
import path from 'path';
import { nativeImage } from 'electron';

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const HEADER_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export const isLocalThumbnailItem = (item, deviceType) =>
  deviceType === 'local' && !item.isFolder && /\.(jpe?g|png)$/i.test(item.name);

// Read only a bounded header. Unusual JPEGs whose dimensions are beyond this
// window keep their icon rather than decoding an unverified source.
export function imageDimensions(header, extension) {
  if (extension === '.png') {
    if (
      header.length >= 24 &&
      header.subarray(0, 8).equals(PNG_SIGNATURE) &&
      header.toString('ascii', 12, 16) === 'IHDR'
    )
      return [header.readUInt32BE(16), header.readUInt32BE(20)];
  } else if (header.length >= 4 && header.readUInt16BE(0) === 0xffd8) {
    let offset = 2;

    while (offset + 3 < header.length) {
      if (header[offset] !== 0xff) break;
      while (header[offset] === 0xff) offset += 1;
      const marker = header[offset];

      offset += 1;
      if (marker === 0xda || marker === 0xd9) break;
      if (!(marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))) {
        if (offset + 2 > header.length) break;
        const length = header.readUInt16BE(offset);

        if (length < 2 || offset + length > header.length) break;
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          ![0xc4, 0xc8, 0xcc].includes(marker) &&
          length >= 7
        )
          return [
            header.readUInt16BE(offset + 5),
            header.readUInt16BE(offset + 3),
          ];
        offset += length;
      }
    }
  }

  throw new Error('Unsupported or invalid image header.');
}

const unchanged = (stat, source) =>
  stat.isFile() &&
  stat.size === source.size &&
  stat.mtimeMs === source.mtimeMs &&
  stat.ctimeMs === source.ctimeMs &&
  stat.ino === source.ino;

export class LocalThumbnailProvider {
  constructor({ files = fs, images = nativeImage } = {}) {
    this.files = files;
    this.images = images;
  }

  async inspect(item) {
    if (!isLocalThumbnailItem(item, 'local'))
      throw new Error('Unsupported thumbnail source.');
    const canonicalPath = await this.files.realpath(item.path);
    const file = await this.files.open(canonicalPath, 'r');

    try {
      const stat = await file.stat();

      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SOURCE_BYTES)
        throw new Error('Thumbnail source exceeds limits.');
      const header = Buffer.alloc(Math.min(stat.size, HEADER_BYTES));
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const [width, height] = imageDimensions(
        header.subarray(0, bytesRead),
        path.extname(item.name).toLowerCase()
      );

      if (
        !width ||
        !height ||
        width > 16384 ||
        height > 16384 ||
        width * height > 40 * 1000 * 1000
      )
        throw new Error('Image dimensions exceed thumbnail limits.');

      return {
        path: canonicalPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
      };
    } finally {
      await file.close();
    }
  }

  async generate(source, dimensions) {
    if (!unchanged(await this.files.stat(source.path), source))
      throw new Error('Thumbnail source changed.');
    const image = await this.images.createThumbnailFromPath(
      source.path,
      dimensions
    );

    if (image.isEmpty()) throw new Error('Thumbnail generation failed.');
    const { width, height } = image.getSize();

    if (
      width <= 0 ||
      height <= 0 ||
      width > dimensions.width ||
      height > dimensions.height ||
      !unchanged(await this.files.stat(source.path), source)
    )
      throw new Error('Invalid or obsolete thumbnail.');
    const bytes = image.toPNG();

    if (
      bytes.length > 256 * 1024 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    )
      throw new Error('Invalid thumbnail output.');

    return { bytes, width, height };
  }
}
