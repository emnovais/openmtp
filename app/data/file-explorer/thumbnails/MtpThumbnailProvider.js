import { promises as fs, constants } from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
import { nativeImage } from 'electron';
import { store } from '../../../store/configureStore';
import {
  captureMtpScope,
  isCurrentMtpScope,
} from '../repositories/FileExplorerRepository';
import fileExplorerController from '../controllers/FileExplorerController';
import { imageDimensions } from './LocalThumbnailProvider';
import { ThumbnailService } from './ThumbnailService';

export const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const listingIds = new WeakMap();
let nextListing = 0;
let service;

const obsoleteThumbnail = () =>
  Object.assign(new Error('Obsolete thumbnail.'), { code: 'THUMBNAIL_STALE' });

export function isMtpThumbnailContextCurrent(context) {
  if (!context) return false;
  const state = store.getState();

  return (
    state.Settings.mtpMode === 'legacy' &&
    state.Home.mtpDevice.isAvailable &&
    state.Home.currentBrowsePath.mtp === context.directory &&
    state.Home.directoryLists.mtp.nodes === context.nodes &&
    isCurrentMtpScope(context.scope)
  );
}

export function captureMtpThumbnailContext(item) {
  const { Home, Settings } = store.getState();

  if (
    Settings.mtpMode !== 'legacy' ||
    item.isFolder ||
    !/\.(jpe?g|png)$/i.test(item.name)
  )
    return null;
  const { nodes } = Home.directoryLists.mtp;
  const scope = captureMtpScope();

  if (
    !nodes.includes(item) ||
    scope.backend !== 'legacy' ||
    !Number.isInteger(scope.storageId)
  )
    return null;
  if (!listingIds.has(nodes)) {
    nextListing += 1;
    listingIds.set(nodes, nextListing);
  }

  const directory = Home.currentBrowsePath.mtp;
  const listing = listingIds.get(nodes);
  const context = {
    scope,
    directory,
    nodes,
    listing,
    key: JSON.stringify([scope, directory, listing]),
  };

  return isMtpThumbnailContextCurrent(context) ? context : null;
}

export function subscribeMtpThumbnailContext(context, invalidate) {
  return store.subscribe(() => {
    if (!isMtpThumbnailContextCurrent(context)) invalidate();
  });
}

export class MtpThumbnailProvider {
  constructor({
    files = fs,
    images = nativeImage,
    controller = fileExplorerController,
    temporaryPath = os.tmpdir(),
    random = randomBytes,
    isCurrent = isMtpThumbnailContextCurrent,
  } = {}) {
    Object.assign(this, {
      files,
      images,
      controller,
      temporaryPath,
      random,
      isCurrent,
    });
    this.cleanupError = null;
    this.ownedDirectories = new Set();
  }

  async inspect(item, context) {
    if (
      !this.isCurrent(context) ||
      item.isFolder ||
      !context.nodes.includes(item) ||
      !/\.(jpe?g|png)$/i.test(item.name) ||
      path.posix.dirname(item.path) !== context.directory
    )
      throw new Error('Obsolete or unsupported Legacy thumbnail.');

    return {
      item,
      context,
      path: item.path,
      identity: context.key,
      mtimeMs: context.listing,
      size: 0,
    };
  }

  async generate(source, dimensions, isWanted = () => true) {
    const contextIsCurrent = () => this.isCurrent(source.context);
    const current = () => isWanted() && contextIsCurrent();

    if (!contextIsCurrent()) throw obsoleteThumbnail();
    if (!isWanted())
      throw Object.assign(new Error('Thumbnail no longer requested.'), {
        code: 'THUMBNAIL_CANCELLED',
      });
    if (this.cleanupError)
      throw new Error('Private thumbnail cache is unavailable.');
    let directory;
    let destination;
    let owned = false;
    let output;

    try {
      const parent = await this.files.realpath(this.temporaryPath);

      directory = await this.files.mkdtemp(
        path.join(parent, 'openmtp-legacy-thumb-')
      );
      this.ownedDirectories.add(directory);
      await this.files.chmod(directory, 0o700);
      if ((await this.files.realpath(directory)) !== directory)
        throw new Error('Private thumbnail cache path changed.');
      destination = path.join(
        directory,
        `${this.random(16).toString('hex')}.thumb`
      );
      const reserved = await this.files.open(destination, 'wx', 0o600);

      owned = true;
      await reserved.close();
      const result = await this.controller.readThumbnail({
        scope: source.context.scope,
        storageId: source.context.scope.storageId,
        filePath: source.item.path,
        destination,
        cacheDirectory: directory,
        isCurrent: current,
      });

      if (
        result?.error ||
        result?.processClosed !== true ||
        result?.exitCode !== 0 ||
        result?.signal !== null ||
        result?.data !== true
      )
        throw new Error('Legacy thumbnail unavailable.');
      // Consumer replacement does not change file/session identity. Finish
      // bounded validation after close; the service decides who can receive it.
      if (!contextIsCurrent()) throw obsoleteThumbnail();
      const stat = await this.files.lstat(destination);

      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size <= 0 ||
        stat.size > MAX_THUMBNAIL_BYTES
      )
        throw new Error('Invalid thumbnail output size or type.');
      const file = await this.files.open(
        destination,
        constants.O_RDONLY + constants.O_NOFOLLOW
      );
      let bytes;

      try {
        const before = await file.stat();

        if (
          !before.isFile() ||
          before.ino !== stat.ino ||
          before.size !== stat.size
        )
          throw new Error('Thumbnail output changed.');
        bytes = Buffer.alloc(before.size);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        const after = await file.stat();

        if (
          bytesRead !== bytes.length ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        )
          throw new Error('Thumbnail output changed while reading.');
      } finally {
        await file.close();
      }

      const format =
        bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
          ? '.png'
          : '.jpg';
      const [width, height] = imageDimensions(bytes, format);

      if (!width || !height || width > 2048 || height > 2048)
        throw new Error('Thumbnail dimensions exceed limits.');
      const image = this.images.createFromBuffer(bytes);

      if (image.isEmpty()) throw new Error('Corrupt thumbnail.');
      const decoded = image.getSize();

      if (
        decoded.width <= 0 ||
        decoded.height <= 0 ||
        decoded.width > 2048 ||
        decoded.height > 2048
      )
        throw new Error('Invalid decoded thumbnail dimensions.');
      const scale = Math.min(
        dimensions.width / decoded.width,
        dimensions.height / decoded.height,
        1
      );
      const preview = image.resize({
        width: Math.max(1, Math.round(decoded.width * scale)),
        height: Math.max(1, Math.round(decoded.height * scale)),
        quality: 'good',
      });
      const png = preview.toPNG();
      const size = preview.getSize();

      if (!contextIsCurrent()) throw obsoleteThumbnail();
      if (
        size.width <= 0 ||
        size.height <= 0 ||
        png.length > 256 * 1024 ||
        size.width > dimensions.width ||
        size.height > dimensions.height ||
        png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      )
        throw new Error('Invalid or obsolete thumbnail preview.');

      output = { bytes: png, ...size };
    } finally {
      await this.cleanup(directory, destination, owned);
    }

    if (!contextIsCurrent()) throw obsoleteThumbnail();

    return output;
  }

  async cleanup(directory, destination, owned) {
    // Never recurse or scan old caches. Only this job's private directory and
    // opaque file may be removed, after the CLI close barrier has settled.
    if (!directory) return;
    if (!this.ownedDirectories.has(directory))
      throw new Error(
        'Thumbnail cache directory is not owned by this provider.'
      );
    try {
      if ((await this.files.realpath(directory)) !== directory)
        throw new Error('Private thumbnail cache path changed.');
      if (
        owned &&
        destination &&
        path.dirname(destination) === directory &&
        /^[a-f0-9]{32}\.thumb$/.test(path.basename(destination))
      ) {
        await this.files.unlink(destination).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }

      await this.files.rmdir(directory);
      this.ownedDirectories.delete(directory);
    } catch (error) {
      this.cleanupError = error;
      throw error;
    }
  }
}

export function getMtpThumbnailService() {
  if (!service)
    service = new ThumbnailService({
      provider: new MtpThumbnailProvider(),
      maxJobs: 1,
      maxPending: 8,
    });

  return service;
}
