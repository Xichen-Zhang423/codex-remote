import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/;

const TYPES = {
  "image/png": {
    extension: "png",
    matches: (buffer) => buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  "image/jpeg": {
    extension: "jpg",
    matches: (buffer) => buffer.length >= 3
      && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  "image/webp": {
    extension: "webp",
    matches: (buffer) => buffer.length >= 12
      && buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP",
  },
  "image/gif": {
    extension: "gif",
    matches: (buffer) => buffer.length >= 6
      && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii")),
  },
};

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function decodedUpperBound(payload) {
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.floor(payload.length * 3 / 4) - padding;
}

function decodeDataUrl(value, maxImageBytes) {
  if (typeof value !== "string") throw new TypeError("image must be a base64 data URL");
  const match = DATA_URL.exec(value);
  if (!match) {
    if (/^data:image\/(?:svg\+xml|bmp|tiff|x-icon)/i.test(value)) {
      throw new Error("unsupported image type; use PNG, JPEG, WebP, or GIF");
    }
    throw new Error("invalid base64 image data URL");
  }

  const [, mime, payload] = match;
  if (!payload || payload.length % 4 !== 0) throw new Error("invalid or empty base64 image data");
  if (decodedUpperBound(payload) > maxImageBytes) {
    throw new Error(`image size exceeds ${maxImageBytes} bytes`);
  }

  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length || buffer.toString("base64") !== payload) {
    throw new Error("invalid or empty base64 image data");
  }
  if (buffer.length > maxImageBytes) throw new Error(`image size exceeds ${maxImageBytes} bytes`);
  const type = TYPES[mime];
  if (!type.matches(buffer)) throw new Error(`image content does not match ${mime} signature`);
  return { buffer, extension: type.extension };
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".."
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function removeOwnedRoot(fsApi, root) {
  if (!root) return;
  try {
    await fsApi.rm(root, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function materializeImages(images = [], options = {}) {
  if (!Array.isArray(images)) throw new TypeError("images must be an array");
  const maxImages = positiveInteger(options.maxImages, DEFAULT_MAX_IMAGES, "maxImages");
  const maxImageBytes = positiveInteger(
    options.maxImageBytes,
    DEFAULT_MAX_IMAGE_BYTES,
    "maxImageBytes",
  );
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  if (images.length > maxImages) throw new Error(`at most ${maxImages} images are allowed`);

  const decoded = [];
  let totalBytes = 0;
  for (const image of images) {
    const entry = decodeDataUrl(image, maxImageBytes);
    totalBytes += entry.buffer.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`total image size exceeds ${maxTotalBytes} bytes`);
    }
    decoded.push(entry);
  }

  if (!decoded.length) {
    return { inputs: [], paths: [], cleanup: async () => {} };
  }

  const fsApi = options.fs ?? nodeFs.promises;
  const base = path.resolve(options.tempDir ?? os.tmpdir());
  let root;
  try {
    await fsApi.mkdir(base, { recursive: true, mode: 0o700 });
    root = await fsApi.mkdtemp(path.join(base, "codex-remote-images-"));
    await fsApi.chmod(root, 0o700);

    const paths = [];
    for (const entry of decoded) {
      const filename = `${randomUUID().replaceAll("-", "")}.${entry.extension}`;
      const target = path.resolve(root, filename);
      if (!isInside(root, target)) throw new Error("generated image path escaped temporary root");
      await fsApi.writeFile(target, entry.buffer, { mode: 0o600, flag: "wx" });
      await fsApi.chmod(target, 0o600);
      paths.push(target);
    }

    let cleanupPromise;
    const cleanup = () => {
      cleanupPromise ??= removeOwnedRoot(fsApi, root);
      return cleanupPromise;
    };
    return {
      inputs: paths.map((imagePath) => ({ type: "localImage", path: imagePath })),
      paths,
      cleanup,
    };
  } catch (error) {
    try {
      await removeOwnedRoot(fsApi, root);
    } catch (cleanupError) {
      error.cause ??= cleanupError;
    }
    throw error;
  }
}
