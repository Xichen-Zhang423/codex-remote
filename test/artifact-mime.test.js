import test from "node:test";
import assert from "node:assert/strict";

import { classifyArtifact, previewKindForRecord } from "../src/artifact-mime.js";

const MiB = 1024 * 1024;
const LIMITS = {
  text: 2 * MiB,
  image: 25 * MiB,
  pdf: 100 * MiB,
};

const MAGIC = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff]),
  gif87a: Buffer.from("GIF87a", "ascii"),
  gif89a: Buffer.from("GIF89a", "ascii"),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
  pdf: Buffer.from("%PDF-1.7\n", "ascii"),
};

const ATTACHMENT = {
  mime: "application/octet-stream",
  encoding: null,
  preview: null,
  previewLimit: 0,
  disposition: "attachment",
};

function expectedPreview(mime, preview, previewLimit, encoding = null) {
  return { mime, encoding, preview, previewLimit, disposition: "inline" };
}

test("allows raster previews only when magic and extension agree", () => {
  for (const [name, head, mime] of [
    ["plot.png", MAGIC.png, "image/png"],
    ["photo.jpg", MAGIC.jpeg, "image/jpeg"],
    ["photo.jpeg", MAGIC.jpeg, "image/jpeg"],
    ["legacy.gif", MAGIC.gif87a, "image/gif"],
    ["animation.gif", MAGIC.gif89a, "image/gif"],
    ["diagram.webp", MAGIC.webp, "image/webp"],
  ]) {
    assert.deepEqual(
      classifyArtifact({ name, head, size: head.length }),
      expectedPreview(mime, "image", LIMITS.image),
      name,
    );
  }
});

test("allows PDF only with both PDF magic and a PDF extension", () => {
  assert.deepEqual(
    classifyArtifact({ name: "report.pdf", head: MAGIC.pdf, size: MAGIC.pdf.length }),
    expectedPreview("application/pdf", "pdf", LIMITS.pdf),
  );
});

test("allows strict text previews and reports UTF-16LE BOM encoding", () => {
  assert.deepEqual(
    classifyArtifact({ name: "notes.txt", head: Buffer.from("plain UTF-8 text"), size: 16 }),
    expectedPreview("text/plain; charset=utf-8", "text", LIMITS.text, "utf-8"),
  );

  const utf16le = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
  assert.deepEqual(
    classifyArtifact({ name: "notes.txt", head: utf16le, size: utf16le.length }),
    expectedPreview("text/plain; charset=utf-16le", "text", LIMITS.text, "utf-16le"),
  );
});

test("forces active and denied file types to attachment", () => {
  for (const name of [
    "page.html",
    "page.htm",
    "image.svg",
    "run.js",
    "run.mjs",
    "run.cjs",
    "data.xml",
    "page.xhtml",
    "sheet.xlsx",
    "document.docx",
    "slides.pptx",
    "bundle.zip",
    "bundle.7z",
    "bundle.rar",
    "tool.exe",
    "library.dll",
    "blob.bin",
  ]) {
    assert.deepEqual(classifyArtifact({ name, head: MAGIC.png, size: MAGIC.png.length }), ATTACHMENT, name);
  }
});

test("forces magic and extension conflicts to attachment", () => {
  for (const artifact of [
    { name: "plot.jpg", head: MAGIC.png },
    { name: "plot.png", head: MAGIC.jpeg },
    { name: "report.txt", head: MAGIC.pdf },
    { name: "report.pdf", head: Buffer.from("ordinary text") },
  ]) {
    assert.deepEqual(
      classifyArtifact({ ...artifact, size: artifact.head.length }),
      ATTACHMENT,
      artifact.name,
    );
  }
});

test("preview limits are inclusive and reject one byte over", () => {
  for (const [name, head, limit, preview] of [
    ["notes.txt", Buffer.from("text"), LIMITS.text, "text"],
    ["plot.png", MAGIC.png, LIMITS.image, "image"],
    ["report.pdf", MAGIC.pdf, LIMITS.pdf, "pdf"],
  ]) {
    assert.equal(classifyArtifact({ name, head, size: limit }).preview, preview, `${name} at limit`);
    assert.deepEqual(classifyArtifact({ name, head, size: limit + 1 }), ATTACHMENT, `${name} over limit`);
  }
});

test("recognizes UTF-16 BOMs but rejects NUL text and invalid UTF-8", () => {
  const utf16be = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  assert.deepEqual(
    classifyArtifact({ name: "notes.md", head: utf16be, size: utf16be.length }),
    expectedPreview("text/plain; charset=utf-16be", "text", LIMITS.text, "utf-16be"),
  );

  for (const head of [
    Buffer.from([0x68, 0x00, 0x69]),
    Buffer.from([0xc3, 0x28]),
  ]) {
    assert.deepEqual(classifyArtifact({ name: "notes.txt", head, size: head.length }), ATTACHMENT);
  }
});

test("rejects truncated and malformed UTF-16 BOM text", () => {
  for (const head of [
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.from([0xfe, 0xff, 0x00]),
    Buffer.from([0xff, 0xfe, 0x00, 0xd8]),
    Buffer.from([0xfe, 0xff, 0xd8, 0x00]),
  ]) {
    assert.deepEqual(classifyArtifact({ name: "notes.txt", head, size: head.length }), ATTACHMENT);
  }
});

test("accepts every restricted text extension after fatal UTF-8 decoding", () => {
  for (const extension of [
    ".txt", ".md", ".json", ".csv", ".log", ".py", ".ts", ".tsx",
    ".css", ".yaml", ".yml", ".toml",
  ]) {
    const result = classifyArtifact({
      name: `artifact${extension}`,
      head: Buffer.from("valid UTF-8: \u2713"),
      size: 12,
    });
    assert.equal(result.preview, "text", extension);
    assert.equal(result.encoding, "utf-8", extension);
  }
});

test("invalid classifier inputs fail closed", () => {
  for (const input of [
    null,
    {},
    { name: null, head: MAGIC.png, size: MAGIC.png.length },
    { name: "unsafe\0.txt", head: Buffer.from("text"), size: 4 },
    { name: "plot.png", head: "not bytes", size: MAGIC.png.length },
    { name: "plot.png", head: MAGIC.png, size: -1 },
    { name: "plot.png", head: MAGIC.png, size: Number.NaN },
    { name: "plot.png", head: MAGIC.png, size: Number.POSITIVE_INFINITY },
  ]) {
    assert.deepEqual(classifyArtifact(input), ATTACHMENT);
  }
});

test("previewKindForRecord trusts only exact persisted MIME values and inclusive sizes", () => {
  for (const [mime, limit, expected] of [
    ["image/png", LIMITS.image, "image"],
    ["image/jpeg", LIMITS.image, "image"],
    ["image/gif", LIMITS.image, "image"],
    ["image/webp", LIMITS.image, "image"],
    ["application/pdf", LIMITS.pdf, "pdf"],
    ["text/plain; charset=utf-8", LIMITS.text, "text"],
    ["text/plain; charset=utf-16le", LIMITS.text, "text"],
    ["text/plain; charset=utf-16be", LIMITS.text, "text"],
  ]) {
    assert.equal(previewKindForRecord({ mime, size: limit }), expected, mime);
    assert.equal(previewKindForRecord({ mime, size: limit + 1 }), null, `${mime} over limit`);
  }
});

test("previewKindForRecord rejects active unknown malformed and loosely matching records", () => {
  for (const record of [
    null,
    {},
    { mime: "image/svg+xml", size: 1 },
    { mime: "image/png; charset=utf-8", size: 1 },
    { mime: "text/html", size: 1 },
    { mime: "application/javascript", size: 1 },
    { mime: "application/octet-stream", size: 1 },
    { mime: "text/plain", size: 1 },
    { mime: "text/plain; charset=utf-8; evil=true", size: 1 },
    { mime: "text/plain; charset=windows-1252", size: 1 },
    { mime: "image/png", size: -1 },
    { mime: "image/png", size: Number.NaN },
    { mime: "image/png", size: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(previewKindForRecord(record), null);
  }
});
