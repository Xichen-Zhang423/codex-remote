import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "public/icon.svg"), "utf8");
const outputs = new Map([
  ["public/icons/icon-16.png", 16], ["public/icons/icon-32.png", 32],
  ["public/icons/icon-180.png", 180], ["public/icons/icon-192.png", 192],
  ["public/icons/icon-512.png", 512], ["public/icons/icon-maskable-512.png", 512],
  ["app-android/resources/mipmap-mdpi/ic_launcher.png", 48],
  ["app-android/resources/mipmap-hdpi/ic_launcher.png", 72],
  ["app-android/resources/mipmap-xhdpi/ic_launcher.png", 96],
  ["app-android/resources/mipmap-xxhdpi/ic_launcher.png", 144],
  ["app-android/resources/mipmap-xxxhdpi/ic_launcher.png", 192],
  ["app-harmony/resources/base/media/app_icon.png", 512],
]);

function maskableSvg(svg) {
  const viewBox = svg.match(/viewBox=["']([^"']+)["']/)?.[1] ?? "0 0 512 512";
  const [, , width, height] = viewBox.split(/\s+/).map(Number);
  const body = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/i)?.[1];
  if (!body || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error("public/icon.svg needs a numeric viewBox");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><rect width="100%" height="100%" fill="#0b0d0c"/><g transform="translate(${width * 0.1} ${height * 0.1}) scale(0.8)">${body}</g></svg>`;
}

function render(svg, size) {
  return new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" }).render().asPng();
}

const check = process.argv.includes("--check");
const stale = [];
for (const [relative, size] of outputs) {
  const target = path.join(root, relative);
  const bytes = render(relative.includes("maskable") ? maskableSvg(source) : source, size);
  if (check) {
    const current = fs.existsSync(target) ? fs.readFileSync(target) : Buffer.alloc(0);
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    if (digest(current) !== digest(bytes)) stale.push(relative);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}
if (stale.length) {
  for (const relative of stale) console.error(`[brand] stale ${relative}`);
  process.exitCode = 1;
} else console.log(check ? "[brand] OK" : `[brand] wrote ${outputs.size} assets`);
