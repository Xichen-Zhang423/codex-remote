import fs from "node:fs";
import path from "node:path";

export function resolveOptionalBinary(name, {
  productRoot,
  env = process.env,
  existsSync = fs.existsSync,
} = {}) {
  if (!productRoot) throw new TypeError("productRoot is required");
  const local = path.join(productRoot, name);
  if (existsSync(local)) return local;
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const managed = path.join(localAppData, "CodexRemote", "bin", name);
    if (existsSync(managed)) return managed;
  }
  return name;
}
