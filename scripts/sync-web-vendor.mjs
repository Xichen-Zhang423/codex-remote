import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = new Map([
  ["node_modules/pdfjs-dist/build/pdf.min.mjs", "public/vendor/pdfjs/pdf.min.mjs"],
  ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "public/vendor/pdfjs/pdf.worker.min.mjs"],
  ["node_modules/pdfjs-dist/LICENSE", "public/vendor/pdfjs/LICENSE"],
]);
const check = process.argv.includes("--check");

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

let failed = false;
for (const [sourceName, destinationName] of files) {
  const source = path.join(root, sourceName);
  const destination = path.join(root, destinationName);
  if (!fs.existsSync(source)) {
    console.error(`Missing PDF.js source: ${sourceName}. Run npm install before syncing vendor assets.`);
    failed = true;
    continue;
  }

  if (check) {
    if (!fs.existsSync(destination)) {
      console.error(`Missing committed vendor asset: ${destinationName}. Run node scripts/sync-web-vendor.mjs.`);
      failed = true;
      continue;
    }
    const sourceHash = sha256(source);
    const destinationHash = sha256(destination);
    if (sourceHash !== destinationHash) {
      console.error(`Vendor asset mismatch: ${destinationName} (expected ${sourceHash}, received ${destinationHash}).`);
      failed = true;
    }
    continue;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

if (failed) process.exitCode = 1;
