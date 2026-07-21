import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(
  appRoot,
  "android",
  "app",
  "src",
  "main",
  "AndroidManifest.xml",
);

if (!fs.existsSync(manifestPath)) {
  console.error("AndroidManifest.xml is missing. Run `npx cap add android` first.");
  process.exit(1);
}

let xml = fs.readFileSync(manifestPath, "utf8");
const declarations = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
];

if (!/<manifest\b[^>]*>/.test(xml)) {
  console.error("AndroidManifest.xml does not contain a manifest root element.");
  process.exit(1);
}

let added = 0;
for (const declaration of declarations) {
  const name = declaration.match(/android:name="([^"]+)"/)?.[1];
  if (name && !xml.includes(`android:name="${name}"`)) {
    xml = xml.replace(/(<manifest\b[^>]*>)/, `$1\n    ${declaration}`);
    added += 1;
  }
}

fs.writeFileSync(manifestPath, xml, "utf8");

const densities = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
for (const density of densities) {
  const source = path.join(appRoot, "resources", `mipmap-${density}`, "ic_launcher.png");
  if (!fs.existsSync(source)) throw new Error(`Missing brand asset: ${source}`);
  const destination = path.join(appRoot, "android", "app", "src", "main", "res", `mipmap-${density}`);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(source, path.join(destination, "ic_launcher.png"));
  fs.copyFileSync(source, path.join(destination, "ic_launcher_round.png"));
}
const adaptive = path.join(appRoot, "android", "app", "src", "main", "res", "mipmap-anydpi-v26");
for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"])
  fs.rmSync(path.join(adaptive, name), { force: true });

console.log(`Android manifest ready (${added} declaration(s) added).`);
