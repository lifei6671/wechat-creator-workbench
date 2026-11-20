import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET
  || execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];
mkdirSync(new URL("../.generated/", import.meta.url), { recursive: true });
const output = fileURLToPath(new URL("../.generated/rust-licenses.json", import.meta.url));
execFileSync("cargo", ["about", "generate", "--manifest-path", "src-tauri/Cargo.toml", "--locked",
  "--offline", "--format", "json", "--target", target, "--fail", "--output-file", output], { cwd: root, stdio: "inherit" });
const report = JSON.parse(readFileSync(output, "utf8"));
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--locked",
  "--offline", "--filter-platform", target, "--format-version", "1"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const runtime = new Set();
function visit(id) {
  if (runtime.has(id) || packages.get(id).targets.some(target => target.kind.includes("proc-macro"))) return;
  runtime.add(id);
  for (const dependency of nodes.get(id).deps) if (dependency.dep_kinds.some(kind => kind.kind === null)) visit(dependency.pkg);
}
visit(metadata.resolve.root);
const runtimeVersions = new Set([...runtime].map(id => `${packages.get(id).name}:${packages.get(id).version}`));
const components = new Map();
for (const license of report.licenses) {
  for (const { crate: crate } of license.used_by) {
    if (!crate.source) continue;
    const key = `${crate.name}:${crate.version}`;
    if (!runtimeVersions.has(key)) continue;
    const entry = components.get(key) ?? { name: crate.name, version: crate.version, ecosystem: "Rust",
      license: crate.license, url: crate.repository || `https://crates.io/crates/${crate.name}`, text: "" };
    if (!entry.text.includes(license.text)) entry.text += `${license.id}\n${license.text}\n\n`;
    components.set(key, entry);
  }
}
writeFileSync(output, JSON.stringify({ target, components: [...components.values()] }));
console.log(`Collected ${components.size} Rust components for ${target}`);
