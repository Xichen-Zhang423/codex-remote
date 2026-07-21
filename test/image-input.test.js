import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeImages } from "../src/image-input.js";

const MAGIC = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
  gif: Buffer.from("GIF89a", "ascii"),
};

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function makeBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-images-test-"));
}

function removeBase(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

test("materializes up to four PNG, JPEG, WebP, and GIF data URLs as unique localImage inputs", async () => {
  const base = makeBase();
  const sources = [
    ["image/png", Buffer.concat([MAGIC.png, Buffer.from("png")])],
    ["image/jpeg", Buffer.concat([MAGIC.jpeg, Buffer.from("jpeg")])],
    ["image/webp", Buffer.concat([MAGIC.webp, Buffer.from("webp")])],
    ["image/gif", Buffer.concat([MAGIC.gif, Buffer.from("gif")])],
  ];
  let temp;
  try {
    temp = await materializeImages(sources.map(([mime, bytes]) => dataUrl(mime, bytes)), { tempDir: base });
    assert.equal(temp.inputs.length, 4);
    assert.equal(temp.paths.length, 4);
    assert.equal(new Set(temp.paths).size, 4);
    assert.deepEqual(temp.inputs, temp.paths.map((imagePath) => ({ type: "localImage", path: imagePath })));
    for (let index = 0; index < temp.paths.length; index += 1) {
      assert.equal(path.isAbsolute(temp.paths[index]), true);
      assert.equal(isInside(base, temp.paths[index]), true);
      assert.deepEqual(fs.readFileSync(temp.paths[index]), sources[index][1]);
    }
  } finally {
    await temp?.cleanup();
    removeBase(base);
  }
});

test("rejects more than four images before creating a temporary directory", async () => {
  const base = makeBase();
  try {
    const image = dataUrl("image/png", MAGIC.png);
    await assert.rejects(materializeImages(new Array(5).fill(image), { tempDir: base }), /4/);
    assert.deepEqual(fs.readdirSync(base), []);
  } finally {
    removeBase(base);
  }
});

test("rejects SVG and unknown image MIME types", async (t) => {
  for (const [name, url] of [
    ["svg", dataUrl("image/svg+xml", Buffer.from("<svg/>"))],
    ["unknown", dataUrl("image/bmp", Buffer.from("BM"))],
  ]) {
    await t.test(name, async () => {
      const base = makeBase();
      try {
        await assert.rejects(materializeImages([url], { tempDir: base }), /unsupported|不支持/i);
        assert.deepEqual(fs.readdirSync(base), []);
      } finally {
        removeBase(base);
      }
    });
  }
});

test("rejects malformed, non-base64, and empty data URLs", async (t) => {
  const cases = [
    "data:image/png;base64",
    "data:image/png,not-base64",
    "data:image/png;base64,%%%%",
    "data:image/png;base64,",
    "https://example.test/image.png",
  ];
  for (const value of cases) {
    await t.test(value.slice(0, 32), async () => {
      const base = makeBase();
      try {
        await assert.rejects(materializeImages([value], { tempDir: base }), /data|base64|empty|无效|为空/i);
        assert.deepEqual(fs.readdirSync(base), []);
      } finally {
        removeBase(base);
      }
    });
  }
});

test("enforces decoded per-image and aggregate byte limits before writing", async (t) => {
  await t.test("per image", async () => {
    const base = makeBase();
    try {
      const bytes = Buffer.concat([MAGIC.png, Buffer.alloc(32)]);
      await assert.rejects(
        materializeImages([dataUrl("image/png", bytes)], { tempDir: base, maxImageBytes: bytes.length - 1 }),
        /size|bytes|大小|过大/i,
      );
      assert.deepEqual(fs.readdirSync(base), []);
    } finally {
      removeBase(base);
    }
  });

  await t.test("aggregate", async () => {
    const base = makeBase();
    try {
      const bytes = Buffer.concat([MAGIC.gif, Buffer.alloc(16)]);
      await assert.rejects(
        materializeImages([
          dataUrl("image/gif", bytes),
          dataUrl("image/gif", bytes),
        ], { tempDir: base, maxImageBytes: bytes.length, maxTotalBytes: bytes.length * 2 - 1 }),
        /total|size|bytes|总大小|过大/i,
      );
      assert.deepEqual(fs.readdirSync(base), []);
    } finally {
      removeBase(base);
    }
  });
});

test("rejects MIME and magic-byte mismatches before writing", async (t) => {
  for (const [mime, wrongBytes] of [
    ["image/png", MAGIC.jpeg],
    ["image/jpeg", MAGIC.webp],
    ["image/webp", MAGIC.gif],
    ["image/gif", MAGIC.png],
  ]) {
    await t.test(mime, async () => {
      const base = makeBase();
      try {
        await assert.rejects(materializeImages([dataUrl(mime, wrongBytes)], { tempDir: base }), /content|signature|magic|格式|类型/i);
        assert.deepEqual(fs.readdirSync(base), []);
      } finally {
        removeBase(base);
      }
    });
  }
});

test("never derives paths from data URL parameters and keeps every file below the owned temp root", async () => {
  const base = makeBase();
  const outside = path.join(path.dirname(base), "owned.png");
  try {
    const payload = MAGIC.png.toString("base64");
    await assert.rejects(
      materializeImages([`data:image/png;name=..%2Fowned.png;base64,${payload}`], { tempDir: base }),
      /data|parameter|unsupported|无效|不支持/i,
    );
    assert.equal(fs.existsSync(outside), false);

    const temp = await materializeImages([dataUrl("image/png", MAGIC.png), dataUrl("image/png", MAGIC.png)], { tempDir: base });
    try {
      for (const imagePath of temp.paths) {
        assert.equal(isInside(base, imagePath), true);
        assert.match(path.basename(imagePath), /^[a-z0-9_-]+\.png$/i);
      }
    } finally {
      await temp.cleanup();
    }
  } finally {
    fs.rmSync(outside, { force: true });
    removeBase(base);
  }
});

test("uses restrictive directory and file permissions", async () => {
  const base = makeBase();
  const calls = [];
  const fsApi = new Proxy(fs.promises, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return async (...args) => {
        calls.push([property, ...args]);
        return value.apply(target, args);
      };
    },
  });
  let temp;
  try {
    temp = await materializeImages([dataUrl("image/png", MAGIC.png)], { tempDir: base, fs: fsApi });
    const root = path.dirname(temp.paths[0]);
    const restrictedDir = calls.some(([name, target, mode]) => name === "chmod" && target === root && mode === 0o700);
    const restrictedFile = calls.some(([name, target, value, options]) => (
      name === "writeFile" && target === temp.paths[0] && options?.mode === 0o600
    )) || calls.some(([name, target, mode]) => name === "chmod" && target === temp.paths[0] && mode === 0o600);
    assert.equal(restrictedDir, true);
    assert.equal(restrictedFile, true);
  } finally {
    await temp?.cleanup();
    removeBase(base);
  }
});

test("cleanup is idempotent after caller success or failure", async (t) => {
  for (const outcome of ["success", "failure"]) {
    await t.test(outcome, async () => {
      const base = makeBase();
      try {
        const temp = await materializeImages([dataUrl("image/jpeg", MAGIC.jpeg)], { tempDir: base });
        const ownedRoot = path.dirname(temp.paths[0]);
        if (outcome === "failure") {
          try {
            throw new Error("caller failed");
          } catch {
            await temp.cleanup();
          }
        } else {
          await temp.cleanup();
        }
        await assert.doesNotReject(temp.cleanup());
        assert.equal(fs.existsSync(ownedRoot), false);
        assert.deepEqual(fs.readdirSync(base), []);
      } finally {
        removeBase(base);
      }
    });
  }
});

test("a partial write failure removes every file and owned temporary directory", async () => {
  const base = makeBase();
  let writes = 0;
  const fsApi = new Proxy(fs.promises, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "writeFile") {
        return async (...args) => {
          writes += 1;
          if (writes === 2) throw new Error("injected write failure");
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await assert.rejects(materializeImages([
      dataUrl("image/png", MAGIC.png),
      dataUrl("image/gif", MAGIC.gif),
    ], { tempDir: base, fs: fsApi }), /injected write failure/);
    assert.deepEqual(fs.readdirSync(base), []);
  } finally {
    removeBase(base);
  }
});
