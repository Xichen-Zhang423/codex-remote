import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PRODUCT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slash = (value) => value.split(path.sep).join("/");
const sorted = (values) => [...new Set(values)].sort();
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const parseJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));
const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};
const semanticJson = (value) => JSON.stringify(stableValue(value));
const defaultRunGit = (root, args) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
});

const REQUIRED_PATHS = [
  "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md",
  "package.json", "package-lock.json", "app-android/package.json", "app-android/package-lock.json",
  "public/index.html", "public/panel.html", "public/panel.js", "public/manifest.webmanifest", "public/sw.js",
  "src/desktop-panel.js",
  ".github/workflows/build-apk.yml",
  ".github/workflows/verify.yml",
];

export function validateRequiredPaths(root) {
  return REQUIRED_PATHS.filter((relative) => !fs.existsSync(path.join(root, relative)))
    .map((relative) => `${relative}: required release path is missing`);
}

export function validateLockfile(root, manifestPath, lockPath) {
  let manifest;
  let lock;
  try { manifest = parseJson(path.join(root, manifestPath)); }
  catch { return [`${manifestPath}: invalid JSON`]; }
  try { lock = parseJson(path.join(root, lockPath)); }
  catch { return [`${lockPath}: invalid JSON`]; }
  const errors = [];
  const rootPackage = lock.packages?.[""] ?? {};
  if (lock.lockfileVersion !== 3) errors.push(`${lockPath}: lockfileVersion must be 3`);
  if (lock.name !== manifest.name || rootPackage.name !== manifest.name) errors.push(`${lockPath}: package name differs from ${manifestPath}`);
  if (lock.version !== manifest.version || rootPackage.version !== manifest.version) errors.push(`${lockPath}: package version differs from ${manifestPath}`);
  for (const key of ["dependencies", "devDependencies"]) {
    if (semanticJson(rootPackage[key] ?? {}) !== semanticJson(manifest[key] ?? {}))
      errors.push(`${lockPath}: ${key} differ from ${manifestPath}`);
  }
  return sorted(errors);
}

const FORBIDDEN_DEPENDENCIES = ["qrcode-terminal"];
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const isForbiddenSpec = (value, dependency) => typeof value === "string"
  && (value === `npm:${dependency}` || value.startsWith(`npm:${dependency}@`));
const referencesForbiddenDependency = (record, dependency) => Object.entries(record ?? {})
  .some(([name, value]) => name === dependency || isForbiddenSpec(value, dependency));

export function validateForbiddenDependencies(root, manifestPath = "package.json", lockPath = "package-lock.json") {
  let manifest;
  let lock;
  try { manifest = parseJson(path.join(root, manifestPath)); }
  catch { return []; }
  try { lock = parseJson(path.join(root, lockPath)); }
  catch { return []; }

  const errors = [];
  const rootPackage = lock.packages?.[""] ?? {};
  for (const dependency of FORBIDDEN_DEPENDENCIES) {
    if (DEPENDENCY_SECTIONS.some((section) => referencesForbiddenDependency(manifest[section], dependency)))
      errors.push(`${manifestPath}: forbidden root dependency ${dependency}`);
    if (DEPENDENCY_SECTIONS.some((section) => referencesForbiddenDependency(rootPackage[section], dependency)))
      errors.push(`${lockPath}: forbidden root dependency ${dependency}`);

    const packageSuffix = `/node_modules/${dependency}`;
    const hasLockedPackage = Object.entries(lock.packages ?? {}).some(([entry, value]) => {
      const normalized = entry.replaceAll("\\", "/");
      return normalized === `node_modules/${dependency}`
        || normalized.endsWith(packageSuffix)
        || (entry !== "" && value?.name === dependency);
    });
    const hasLockedReference = Object.entries(lock.packages ?? {}).some(([entry, value]) =>
      entry !== "" && DEPENDENCY_SECTIONS.some((section) => referencesForbiddenDependency(value?.[section], dependency)));
    if (hasLockedPackage || hasLockedReference)
      errors.push(`${lockPath}: forbidden transitive dependency ${dependency}`);
  }
  return sorted(errors);
}

function walk(root, directory = root, options = {}) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", ".npm-cache"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = slash(path.relative(root, absolute));
    if (entry.isSymbolicLink()) {
      options.linkErrors?.push(`${relative}: filesystem link is forbidden`);
      continue;
    }
    if (entry.isDirectory()) {
      if (options.onDirectory?.(relative)) continue;
      files.push(...walk(root, absolute, options));
    }
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function skipInlineCode(text, start) {
  let width = 1;
  while (text[start + width] === "`") width += 1;
  const marker = "`".repeat(width);
  const closing = text.indexOf(marker, start + width);
  return closing < 0 ? start + width : closing + width;
}

function finishInlineDestination(text, start, raw) {
  for (let cursor = start; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") { cursor += 1; continue; }
    if (text[cursor] === ")") return { raw, next: cursor + 1 };
  }
  return { raw: null, next: text.length };
}

function parseMarkdownDestination(text, start, allowEnd = false) {
  let cursor = start;
  while (cursor < text.length && /[ \t]/.test(text[cursor])) cursor += 1;
  if (text[cursor] === "<") {
    let raw = "";
    for (cursor += 1; cursor < text.length; cursor += 1) {
      if (text[cursor] === "\\" && cursor + 1 < text.length) raw += text[++cursor];
      else if (text[cursor] === ">")
        return allowEnd ? { raw, next: cursor + 1 } : finishInlineDestination(text, cursor + 1, raw);
      else if (/\r|\n/.test(text[cursor])) return { raw: null, next: cursor + 1 };
      else raw += text[cursor];
    }
    return { raw: null, next: text.length };
  }
  let raw = "";
  let depth = 0;
  for (; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === "\\" && cursor + 1 < text.length) {
      raw += text[++cursor];
      continue;
    }
    if (character === "(") { depth += 1; raw += character; continue; }
    if (character === ")") {
      if (depth === 0) return { raw, next: cursor + 1 };
      depth -= 1;
      raw += character;
      continue;
    }
    if (/\s/.test(character) && depth === 0)
      return allowEnd ? { raw, next: cursor + 1 } : finishInlineDestination(text, cursor + 1, raw);
    raw += character;
  }
  return allowEnd && depth === 0 ? { raw, next: text.length } : { raw: null, next: text.length };
}

function closingMarkdownBracket(text, start) {
  let depth = 1;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") { cursor += 1; continue; }
    if (text[cursor] === "`") { cursor = skipInlineCode(text, cursor) - 1; continue; }
    if (text[cursor] === "[") depth += 1;
    else if (text[cursor] === "]" && --depth === 0) return cursor;
  }
  return -1;
}

function inlineMarkdownDestinations(line) {
  const destinations = [];
  for (let cursor = 0; cursor < line.length;) {
    if (line[cursor] === "\\") { cursor += 2; continue; }
    if (line[cursor] === "`") { cursor = skipInlineCode(line, cursor); continue; }
    if (line[cursor] !== "[") { cursor += 1; continue; }
    const closing = closingMarkdownBracket(line, cursor);
    if (closing < 0) break;
    if (line[closing + 1] !== "(") { cursor = closing + 1; continue; }
    const parsed = parseMarkdownDestination(line, closing + 2);
    if (parsed.raw) destinations.push(parsed.raw);
    cursor = Math.max(parsed.next, closing + 2);
  }
  return destinations;
}

function markdownDestinations(text) {
  const destinations = [];
  let fence;
  for (const line of text.split(/\r?\n/)) {
    const fenceMarker = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (fenceMarker?.[0] === fence.character && fenceMarker.length >= fence.width
        && new RegExp(`^[ ]{0,3}${fence.character}{${fence.width},}[ \\t]*$`).test(line)) fence = undefined;
      continue;
    }
    if (fenceMarker) {
      fence = { character: fenceMarker[0], width: fenceMarker.length };
      continue;
    }
    const definition = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(.*)$/.exec(line);
    if (definition && !definition[1].startsWith("^")) {
      const parsed = parseMarkdownDestination(definition[2], 0, true);
      if (parsed.raw) destinations.push(parsed.raw);
    }
    destinations.push(...inlineMarkdownDestinations(line));
  }
  return destinations;
}

export function validateMarkdownLinks(root) {
  const errors = [];
  let realRoot;
  try { realRoot = fs.realpathSync.native(root); }
  catch { return ["product root: unavailable for Markdown validation"]; }
  for (const file of walk(root).filter((name) => name.endsWith(".md"))) {
    const relativeFile = slash(path.relative(root, file));
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch { errors.push(`${relativeFile}: Markdown file is unreadable`); continue; }
    for (const raw of markdownDestinations(text)) {
      if (!raw || raw.startsWith("#") || /^(?:https?:|mailto:)/i.test(raw)) continue;
      const encodedPath = raw.split(/[?#]/, 1)[0];
      if (!encodedPath) continue;
      let decoded;
      try { decoded = decodeURIComponent(encodedPath); }
      catch { errors.push(`${relativeFile}: invalid URL encoding: ${raw}`); continue; }
      const target = path.resolve(path.dirname(file), decoded);
      if (!inside(root, target)) {
        errors.push(`${relativeFile}: local link escapes product root: ${raw}`);
        continue;
      }
      let stat;
      try { stat = fs.lstatSync(target); }
      catch { errors.push(`${relativeFile}: missing local link: ${decoded}`); continue; }
      try {
        const realTarget = fs.realpathSync.native(target);
        if (!inside(realRoot, realTarget))
          errors.push(`${relativeFile}: local link escapes product root through filesystem link: ${raw}`);
      } catch {
        errors.push(`${relativeFile}: local link is unavailable: ${decoded}`);
      }
      if (!stat.isFile() && !stat.isDirectory())
        errors.push(`${relativeFile}: local link is not a file or directory: ${decoded}`);
    }
  }
  return sorted(errors);
}

const SHELL_ASSETS = [
  "index.html", "panel.html", "panel.js", "styles.css", "app.js", "artifact-ui.js", "icon.svg",
  "manifest.webmanifest", "jsqr.min.js", "vendor/pdfjs/pdf.min.mjs", "vendor/pdfjs/pdf.worker.min.mjs",
];

export function validatePwaShell(root) {
  const errors = [];
  const manifestPath = path.join(root, "public", "manifest.webmanifest");
  const publicRoot = path.join(root, "public");
  let publicStat;
  let realRoot;
  let realPublicRoot;
  try { publicStat = fs.lstatSync(publicRoot); }
  catch { return ["public: PWA root is missing"]; }
  if (!publicStat.isDirectory() || publicStat.isSymbolicLink())
    return ["public: PWA root is not a real directory inside product root"];
  try {
    realRoot = fs.realpathSync.native(root);
    realPublicRoot = fs.realpathSync.native(publicRoot);
    const expectedPublicRoot = path.resolve(realRoot, path.relative(root, publicRoot));
    if (!inside(realRoot, realPublicRoot) || realPublicRoot !== expectedPublicRoot)
      return ["public: PWA root is not a real directory inside product root"];
  } catch {
    return ["public: PWA root is unavailable"];
  }
  let manifestStat;
  try { manifestStat = fs.lstatSync(manifestPath); }
  catch { return ["public/manifest.webmanifest: invalid JSON"]; }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    return ["public/manifest.webmanifest: PWA manifest is not a regular file"];
  try {
    const realManifest = fs.realpathSync.native(manifestPath);
    const expectedManifest = path.resolve(realPublicRoot, path.relative(publicRoot, manifestPath));
    if (!inside(realPublicRoot, realManifest) || realManifest !== expectedManifest)
      return ["public/manifest.webmanifest: PWA manifest is not a regular file"];
  } catch {
    return ["public/manifest.webmanifest: PWA manifest is unavailable"];
  }
  let manifest;
  try { manifest = parseJson(manifestPath); }
  catch { return ["public/manifest.webmanifest: invalid JSON"]; }
  for (const key of ["name", "short_name", "start_url", "display", "theme_color"])
    if (!manifest[key]) errors.push(`public/manifest.webmanifest: missing ${key}`);
  for (const icon of manifest.icons ?? []) {
    const raw = typeof icon?.src === "string" ? icon.src : "<invalid>";
    const label = `public/${raw}`;
    let decoded;
    try { decoded = decodeURIComponent(raw.split(/[?#]/, 1)[0]); }
    catch { errors.push(`${label}: manifest icon has invalid URL encoding`); continue; }
    const target = path.resolve(publicRoot, decoded);
    if (!inside(publicRoot, target)) {
      errors.push(`${label}: manifest icon escapes public root`);
      continue;
    }
    let stat;
    try { stat = fs.lstatSync(target); }
    catch { errors.push(`${label}: manifest icon is missing`); continue; }
    if (!stat.isFile()) {
      errors.push(`${label}: manifest icon is not a regular file`);
      continue;
    }
    try {
      const realTarget = fs.realpathSync.native(target);
      const expectedRealTarget = path.resolve(realPublicRoot, path.relative(publicRoot, target));
      if (!realPublicRoot || !inside(realPublicRoot, realTarget) || realTarget !== expectedRealTarget)
        errors.push(`${label}: manifest icon escapes public root through filesystem link`);
    } catch {
      errors.push(`${label}: manifest icon is unavailable`);
    }
  }
  const swPath = path.join(root, "public", "sw.js");
  let sw;
  let swStat;
  try { swStat = fs.lstatSync(swPath); }
  catch { errors.push("public/sw.js: PWA shell is missing"); }
  if (swStat && !swStat.isFile()) errors.push("public/sw.js: PWA shell is not a regular file");
  else if (swStat) {
    try { sw = fs.readFileSync(swPath, "utf8"); }
    catch { errors.push("public/sw.js: PWA shell is unreadable"); }
  }
  if (sw !== undefined) {
    for (const asset of SHELL_ASSETS)
      if (!sw.includes(asset)) errors.push(`public/sw.js: shell does not cache ${asset}`);
  }
  return sorted(errors);
}

export function validateRuntimeIndependence(root) {
  const errors = [];
  const sourceRoot = path.join(root, "src");
  let sourceStat;
  try { sourceStat = fs.lstatSync(sourceRoot); }
  catch { errors.push("src: runtime source directory is missing"); }
  let sourceFiles = [];
  if (sourceStat && (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()))
    errors.push("src: runtime source is not a directory");
  else if (sourceStat) {
    try { sourceFiles = walk(root, sourceRoot); }
    catch { errors.push("src: runtime source directory is unreadable"); }
  }
  const candidates = [path.join(root, "server.js"), ...sourceFiles, path.join(root, "scripts", "bootstrap.js")]
    .filter((file) => fs.existsSync(file) && /\.(?:js|mjs)$/.test(file));
  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch { errors.push(`${slash(path.relative(root, file))}: runtime source is unreadable`); continue; }
    if (/path\.(?:resolve|join)\([^\n)]*["']\.\.["']/.test(text) || /path\.dirname\(\s*prepared\.sourceDir\s*\)/.test(text))
      errors.push(`${slash(path.relative(root, file))}: parent-directory runtime lookup`);
  }
  return sorted(errors);
}

const FORBIDDEN_EXT = /\.(?:exe|apk|aab|hap|keystore|jks|p12|pfx|pem|key|mobileprovision|part)$/i;
const GENERIC_FORBIDDEN_DIR = /(?:^|\/)(?:coverage|logs?|tmp)(?:\/|$)/i;
const ANDROID_BUILD_DIR = /^app-android\/android(?:\/|$)/i;
const FIXED_NATIVE_PNG = /^(?:app-android\/resources\/mipmap-(?:mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)\/ic_launcher\.png|app-harmony\/resources\/base\/media\/app_icon\.png)$/;

export function validateForbiddenFiles(root) {
  const errors = [];
  let publicIcons = new Set();
  const readmeImages = new Set();
  try {
    const manifest = parseJson(path.join(root, "public", "manifest.webmanifest"));
    publicIcons = new Set((manifest.icons ?? []).map((icon) => slash(path.join("public", icon.src))));
  } catch { /* manifest validation reports this separately */ }
  try {
    const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
    for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
      if (!/\brel=["'][^"']*(?:icon|apple-touch-icon)[^"']*["']/i.test(tag[0])) continue;
      const href = /\bhref=["']([^"']+)["']/i.exec(tag[0])?.[1]?.split(/[?#]/, 1)[0];
      if (!href || /^(?:https?:|data:|\/\/)/i.test(href)) continue;
      const target = path.resolve(root, "public", decodeURIComponent(href));
      if (inside(path.join(root, "public"), target)) publicIcons.add(slash(path.relative(root, target)));
    }
  } catch { /* required-path and PWA validators report the missing or malformed shell */ }
  try {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const imageRoot = path.join(root, "docs", "images");
    const addReadmeImage = (raw) => {
      if (!raw || /^(?:https?:|data:|\/\/)/i.test(raw)) return;
      const encodedPath = raw.split(/[?#]/, 1)[0];
      let decoded;
      try { decoded = decodeURIComponent(encodedPath); }
      catch { return; }
      const target = path.resolve(root, decoded);
      if (inside(imageRoot, target) && target.toLowerCase().endsWith(".png"))
        readmeImages.add(slash(path.relative(root, target)));
    };
    for (const raw of markdownDestinations(readme)) addReadmeImage(raw);
    for (const tag of readme.matchAll(/<img\b[^>]*>/gi)) {
      const src = /\bsrc=["']([^"']+)["']/i.exec(tag[0])?.[1];
      addReadmeImage(src);
    }
  } catch { /* required-path and Markdown validators report a missing or malformed README */ }
  const files = walk(root, root, {
    linkErrors: errors,
    onDirectory(relative) {
      if (!GENERIC_FORBIDDEN_DIR.test(relative) && !ANDROID_BUILD_DIR.test(relative)) return false;
      errors.push(`${relative}: forbidden release directory`);
      return true;
    },
  });
  for (const file of files) {
    const relative = slash(path.relative(root, file));
    const base = path.basename(file).toLowerCase();
    if (["config.json", "runtime-state.json", ".env"].includes(base)
      || base.startsWith(".env.") || FORBIDDEN_EXT.test(relative))
      errors.push(`${relative}: forbidden release file`);
    if (relative.toLowerCase().endsWith(".png") && !publicIcons.has(relative)
      && !readmeImages.has(relative) && !FIXED_NATIVE_PNG.test(relative))
      errors.push(`${relative}: unreferenced PNG is forbidden`);
  }
  return sorted(errors);
}

export function validateGitClean(root, runGit = defaultRunGit) {
  const output = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."]);
  return output.trim() ? ["git: product subtree is dirty"] : [];
}

const HISTORY_RULES = [
  ["token", /(?:sk-[A-Za-z0-9_-]{20,}|[?&]token=[A-Za-z0-9._~-]{32,})/],
  ["bearer", /authorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ["private-key", /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/],
  ["client-secret", /client[_-]?secret\s*[:=]\s*["'][^"']{12,}/i],
];

const UNSAFE_HISTORY_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const safeHistoryPath = (value) => typeof value !== "string"
  || value.length > 1024
  || UNSAFE_HISTORY_TEXT.test(value)
  || HISTORY_RULES.some(([, pattern]) => pattern.test(value))
  ? "<redacted-path>"
  : value;
const safeHistoryCommit = (value) => /^[a-f0-9]{6,64}$/i.test(value) ? value : "unknown";

function decodeGitQuotedPath(value) {
  if (!value.startsWith('"')) return value.split("\t", 1)[0];
  const chunks = [];
  let plain = "";
  const flush = () => {
    if (plain) chunks.push(Buffer.from(plain, "utf8"));
    plain = "";
  };
  for (let cursor = 1; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (character === '"') {
      flush();
      try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { return null; }
    }
    if (character !== "\\") { plain += character; continue; }
    const escaped = value[++cursor];
    if (escaped === undefined) return null;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(value[cursor + 1] ?? "")) octal += value[++cursor];
      flush();
      chunks.push(Buffer.from([Number.parseInt(octal, 8)]));
      continue;
    }
    const escapes = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' };
    if (!(escaped in escapes)) return null;
    plain += escapes[escaped];
  }
  return null;
}

function gitPatchPath(line, prefix) {
  const value = line.slice(4).trim();
  if (value === "/dev/null") return null;
  const decoded = decodeGitQuotedPath(value);
  if (!decoded || !decoded.startsWith(`${prefix}/`)) return undefined;
  return decoded.slice(2) || undefined;
}

export function validateGitHistory(root, runGit = defaultRunGit) {
  let output;
  try { output = runGit(root, ["log", "--all", "--format=__COMMIT__%H", "-p", "--", "."]); }
  catch { return ["git history unavailable redacted scan failed"]; }
  const findings = [];
  let commit = "unknown";
  let file = "unknown";
  let oldFile = "unknown";
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("__COMMIT__")) {
      commit = line.slice(10);
      file = "unknown";
      oldFile = "unknown";
      continue;
    }
    if (line.startsWith("diff --git")) { file = "unknown"; oldFile = "unknown"; continue; }
    if (line.startsWith("--- ")) {
      oldFile = gitPatchPath(line, "a") ?? "unknown";
      if (file === "unknown") file = oldFile;
    } else if (line.startsWith("+++ ")) {
      const nextFile = gitPatchPath(line, "b");
      file = nextFile === null ? oldFile : (nextFile ?? "unknown");
    }
    for (const [rule, pattern] of HISTORY_RULES)
      if (pattern.test(line)) findings.push(`${safeHistoryCommit(commit)} ${safeHistoryPath(file)} ${rule}`);
  }
  return sorted(findings);
}

export function verifyRelease(root, { allowDirty = false, includeHistory = false, runGit = defaultRunGit } = {}) {
  const errors = [];
  const checks = [
    ["required paths", () => validateRequiredPaths(root)],
    ["root lockfile", () => validateLockfile(root, "package.json", "package-lock.json")],
    ["Android lockfile", () => validateLockfile(root, "app-android/package.json", "app-android/package-lock.json")],
    ["root forbidden dependencies", () => validateForbiddenDependencies(root)],
    ["Android forbidden dependencies", () => validateForbiddenDependencies(root, "app-android/package.json", "app-android/package-lock.json")],
    ["Markdown links", () => validateMarkdownLinks(root)],
    ["PWA shell", () => validatePwaShell(root)],
    ["runtime independence", () => validateRuntimeIndependence(root)],
    ["forbidden files", () => validateForbiddenFiles(root)],
  ];
  if (!allowDirty) checks.push(["git cleanliness", () => validateGitClean(root, runGit)]);
  if (includeHistory) checks.push(["git history", () => validateGitHistory(root, runGit)]);
  for (const [label, check] of checks) {
    try { errors.push(...check()); }
    catch { errors.push(`${label}: validation unavailable`); }
  }
  return sorted(errors);
}

let isEntryPoint = false;
if (process.argv[1]) {
  try {
    isEntryPoint = fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));
  } catch { /* an unresolvable caller is not this module's CLI entry point */ }
}
if (isEntryPoint) {
  const errors = verifyRelease(PRODUCT_ROOT, {
    allowDirty: process.argv.includes("--allow-dirty"),
    includeHistory: process.argv.includes("--history"),
  });
  if (errors.length) {
    for (const error of errors) console.error(`[release] ERROR ${error}`);
    process.exitCode = 1;
  } else {
    console.log("[release] OK");
  }
}
