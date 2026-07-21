import path from "node:path";

const MiB = 1024 * 1024;

const ACTIVE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".svg",
  ".js",
  ".mjs",
  ".cjs",
  ".xml",
  ".xhtml",
]);

const DENIED_EXTENSIONS = new Set([
  ".zip",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".docx",
  ".xlsx",
  ".pptx",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".log",
  ".py",
  ".ts",
  ".tsx",
  ".css",
  ".yaml",
  ".yml",
  ".toml",
]);

const RASTER_TYPES = Object.freeze({
  png: Object.freeze({ mime: "image/png", extensions: new Set([".png"]) }),
  jpeg: Object.freeze({ mime: "image/jpeg", extensions: new Set([".jpg", ".jpeg"]) }),
  gif: Object.freeze({ mime: "image/gif", extensions: new Set([".gif"]) }),
  webp: Object.freeze({ mime: "image/webp", extensions: new Set([".webp"]) }),
});

const LIMITS = Object.freeze({
  text: 2 * MiB,
  image: 25 * MiB,
  pdf: 100 * MiB,
});

const ATTACHMENT = Object.freeze({
  mime: "application/octet-stream",
  encoding: null,
  preview: null,
  previewLimit: 0,
  disposition: "attachment",
});

function attachment() {
  return { ...ATTACHMENT };
}

function hasPrefix(head, bytes) {
  return head.length >= bytes.length && head.subarray(0, bytes.length).equals(bytes);
}

function rasterType(head) {
  if (hasPrefix(head, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "jpeg";
  }
  if (hasPrefix(head, Buffer.from("GIF87a", "ascii"))
      || hasPrefix(head, Buffer.from("GIF89a", "ascii"))) {
    return "gif";
  }
  if (head.length >= 12
      && head.subarray(0, 4).toString("ascii") === "RIFF"
      && head.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  return null;
}

function isPdf(head) {
  return hasPrefix(head, Buffer.from("%PDF-", "ascii"));
}

function textEncoding(head) {
  let encoding = null;
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) encoding = "utf-16le";
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) encoding = "utf-16be";
  if (encoding) {
    try {
      new TextDecoder(encoding, { fatal: true }).decode(head);
      return encoding;
    } catch {
      return null;
    }
  }
  if (head.includes(0x00)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return "utf-8";
  } catch {
    return null;
  }
}

function previewResult(mime, encoding, preview, previewLimit) {
  return { mime, encoding, preview, previewLimit, disposition: "inline" };
}

function validSize(size) {
  return Number.isSafeInteger(size) && size >= 0;
}

export function classifyArtifact(input) {
  if (!input || typeof input !== "object") return attachment();
  const { name, head = Buffer.alloc(0), size = 0 } = input;
  if (typeof name !== "string"
      || name.length === 0
      || name.includes("\0")
      || !Buffer.isBuffer(head)
      || !validSize(size)) {
    return attachment();
  }

  const extension = path.extname(name).toLowerCase();
  if (ACTIVE_EXTENSIONS.has(extension) || DENIED_EXTENSIONS.has(extension)) return attachment();

  const detectedRaster = rasterType(head);
  if (detectedRaster) {
    const type = RASTER_TYPES[detectedRaster];
    if (!type.extensions.has(extension) || size > LIMITS.image) return attachment();
    return previewResult(type.mime, null, "image", LIMITS.image);
  }
  if ([...Object.values(RASTER_TYPES)].some((type) => type.extensions.has(extension))) {
    return attachment();
  }

  const detectedPdf = isPdf(head);
  if (detectedPdf || extension === ".pdf") {
    if (!detectedPdf || extension !== ".pdf" || size > LIMITS.pdf) return attachment();
    return previewResult("application/pdf", null, "pdf", LIMITS.pdf);
  }

  if (!TEXT_EXTENSIONS.has(extension)) return attachment();
  const encoding = textEncoding(head);
  if (!encoding || size > LIMITS.text) return attachment();
  return previewResult(`text/plain; charset=${encoding}`, encoding, "text", LIMITS.text);
}

const PERSISTED_PREVIEWS = new Map([
  ["image/png", Object.freeze({ kind: "image", limit: LIMITS.image })],
  ["image/jpeg", Object.freeze({ kind: "image", limit: LIMITS.image })],
  ["image/gif", Object.freeze({ kind: "image", limit: LIMITS.image })],
  ["image/webp", Object.freeze({ kind: "image", limit: LIMITS.image })],
  ["application/pdf", Object.freeze({ kind: "pdf", limit: LIMITS.pdf })],
  ["text/plain; charset=utf-8", Object.freeze({ kind: "text", limit: LIMITS.text })],
  ["text/plain; charset=utf-16le", Object.freeze({ kind: "text", limit: LIMITS.text })],
  ["text/plain; charset=utf-16be", Object.freeze({ kind: "text", limit: LIMITS.text })],
]);

export function previewKindForRecord(record) {
  if (!record || typeof record !== "object" || !validSize(record.size)) return null;
  const policy = PERSISTED_PREVIEWS.get(record.mime);
  return policy && record.size <= policy.limit ? policy.kind : null;
}
