import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("open-source metadata is complete and release-specific", () => {
  const required = [
    "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "THIRD_PARTY_NOTICES.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/pull_request_template.md",
  ];
  for (const name of required) assert.equal(fs.existsSync(path.join(root, name)), true, name);
  const pkg = JSON.parse(read("package.json"));
  const license = read("LICENSE");
  const security = read("SECURITY.md");
  const allMetadata = required.map(read).join("\n");
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.dependencies["@openai/codex"], "0.144.1");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Xichen-Zhang423/);
  assert.match(security, /GitHub Security Advisories/i);
  assert.doesNotMatch(allMetadata, /example\.com|TO[D]O|YOUR[_ -]NAME|OWNER\/REPO/i);
  assert.match(read("THIRD_PARTY_NOTICES.md"), /PDF\.js[\s\S]*Apache-2\.0/i);
});

test("templates require reproducible and redacted reports", () => {
  const bug = read(".github/ISSUE_TEMPLATE/bug_report.yml");
  for (const phrase of ["Windows", "Node", "Codex", "复现", "预期", "实际", "脱敏日志"])
    assert.match(bug, new RegExp(phrase, "i"));
  assert.match(bug, /token[\s\S]*二维码[\s\S]*config\.json[\s\S]*凭据/i);
  const feature = read(".github/ISSUE_TEMPLATE/feature_request.yml");
  for (const phrase of ["问题", "期望结果", "替代方案", "影响范围"])
    assert.match(feature, new RegExp(phrase));
  const pr = read(".github/pull_request_template.md");
  for (const phrase of ["npm run verify", "安全", "文档", "CHANGELOG", "360", "390", "430", "1440"])
    assert.match(pr, new RegExp(phrase, "i"));
});
