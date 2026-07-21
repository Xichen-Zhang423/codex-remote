import fs from "node:fs";
import path from "node:path";

export function resolveOptionalBinary(name, { productRoot, existsSync = fs.existsSync } = {}) {
  if (!productRoot) throw new TypeError("productRoot is required");
  const local = path.join(productRoot, name);
  return existsSync(local) ? local : name;
}
