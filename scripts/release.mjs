import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repo = "lifei6671/wechat-creator-workbench";
export const targets = {
  "aarch64-apple-darwin": { label: "mac-arm64", key: "darwin-aarch64", bundle: "macos", extension: ".app.tar.gz" },
  "x86_64-apple-darwin": { label: "mac-x64", key: "darwin-x86_64", bundle: "macos", extension: ".app.tar.gz" },
  "x86_64-pc-windows-msvc": { label: "windows-x64", key: "windows-x86_64", bundle: "nsis", extension: ".exe" },
};
export function releaseVersion(tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) throw new Error("发行标签须为 vX.Y.Z 正式版本");
  return tag.slice(1);
}
export function releaseNotes(root, tag) {
  releaseVersion(tag);
  const text = readFileSync(join(root, "docs/releases", `${tag}.md`), "utf8").trim();
  if (text.length < 160 || !/[\u4e00-\u9fff]/.test(text) || /\bTODO\b|\bTBD\b|待填写|占位内容|<填写/i.test(text)) {
    throw new Error("请提交本次发行的详细中文更新记录，移除占位内容");
  }
  return text;
}
export function injectVersion(root, tag) {
  const version = releaseVersion(tag);
  for (const path of ["package.json", "src-tauri/tauri.conf.json", "apps/sync-server/package.json"]) {
    const file = join(root, path), value = JSON.parse(readFileSync(file, "utf8"));
    value.version = version; writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  }
  const lockPath = join(root, "apps/sync-server/package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.version = version; lock.packages[""].version = version;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  for (const path of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    const file = join(root, path), source = readFileSync(file, "utf8");
    const pattern = path.endsWith(".toml")
      ? /(\[package\][\s\S]*?\nversion = ")[^"]+("\r?\n)/
      : /(\[\[package\]\]\r?\nname = "wechat-creator-workbench"\r?\nversion = ")[^"]+("\r?\n)/;
    if (!pattern.test(source)) throw new Error(`无法找到本项目版本记录：${path}`);
    writeFileSync(file, source.replace(pattern, (_, before, after) => `${before}${version}${after}`));
  }
  verifyVersions(root, version);
  return version;
}
export function verifyVersions(root, version) {
  for (const path of ["package.json", "src-tauri/tauri.conf.json", "apps/sync-server/package.json", "apps/sync-server/package-lock.json"]) {
    const value = JSON.parse(readFileSync(join(root, path), "utf8"));
    if (value.version !== version || (value.packages && value.packages[""].version !== version)) throw new Error(`版本不一致：${path}`);
  }
  const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8").match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)[1];
  const locked = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8").match(/name = "wechat-creator-workbench"\r?\nversion = "([^"]+)"/)[1];
  if (cargo !== version || locked !== version) throw new Error("Rust 版本不一致");
}
export function expectedFiles(version) {
  return [...Object.values(targets).flatMap(target => {
    const name = `CreatorWorkbench-${version}-${target.label}`;
    return [name + target.extension, name + target.extension + ".sig", ...(target.label.startsWith("mac") ? [name + ".dmg"] : [])];
  }), ...["cloudflare", "vps"].map(platform => `CreatorWorkbench-${version}-sync-${platform}.tar.gz`)];
}
export function manifest(directory, tag, notes) {
  const version = releaseVersion(tag), files = expectedFiles(version);
  for (const file of files) {
    if (!existsSync(join(directory, file)) || statSync(join(directory, file)).size === 0) throw new Error(`发行产物缺失：${file}`);
  }
  const platforms = {};
  for (const target of Object.values(targets)) {
    const name = `CreatorWorkbench-${version}-${target.label}${target.extension}`;
    const signature = readFileSync(join(directory, name + ".sig"), "utf8").trim();
    if (!Buffer.from(signature, "base64").toString().startsWith("untrusted comment:")) throw new Error(`更新签名格式错误：${name}`);
    platforms[target.key] = { signature, url: `https://github.com/${repo}/releases/download/${tag}/${name}` };
  }
  return { version, notes, pub_date: new Date().toISOString(), platforms };
}
function collect(root, tag, triple) {
  const version = releaseVersion(tag), target = targets[triple];
  if (!target) throw new Error("不支持的发行目标");
  const directory = join(root, "src-tauri/target", triple, "release/bundle");
  const output = join(root, "release-output"); mkdirSync(output, { recursive: true });
  const types = [[target.bundle, target.extension], ...(target.bundle === "macos" ? [["dmg", ".dmg"]] : [])];
  for (const [folder, extension] of types) {
    const matches = readdirSync(join(directory, folder)).filter(file => file.endsWith(extension));
    if (matches.length !== 1) throw new Error(`预期一个 ${extension} 产物，实际为 ${matches.length}`);
    const source = join(directory, folder, matches[0]);
    const name = `CreatorWorkbench-${version}-${target.label}${extension}`;
    copyFileSync(source, join(output, name));
    if (extension === target.extension) copyFileSync(source + ".sig", join(output, name + ".sig"));
  }
}
const downloadGuide = `\n\n## 下载与安装\n\n- Windows x64：下载 windows-x64.exe，安装及卸载向导为简体中文。\n- Mac Intel：下载 mac-x64.dmg；Apple 芯片：下载 mac-arm64.dmg。应用采用 ad-hoc 签名，未经 Apple 公证，首次打开可能需在系统“隐私与安全性”中允许打开。后续可在“设置 → 关于”安装更新；如系统再次要求放行，请使用同架构 DMG 手动安装。\n- .app.tar.gz、.sig 和 latest.json 用于应用内更新。\n- sync-cloudflare.tar.gz 和 sync-vps.tar.gz 为两种已编译同步服务端，按包内 README.md 部署或升级，保留原数据库、素材与持久化卷。桌面更新不会自动更新服务端。\n`;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const [command, tag, triple] = process.argv.slice(2);
  if (command === "prepare") {
    releaseNotes(root, tag);
    injectVersion(root, tag);
    const publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
    if (!publicKey || !Buffer.from(publicKey, "base64").toString().startsWith("untrusted comment:")) throw new Error("请配置 TAURI_UPDATER_PUBLIC_KEY");
    mkdirSync(join(root, ".generated"), { recursive: true });
    writeFileSync(join(root, ".generated/release-config.json"), JSON.stringify({ bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: publicKey } } }));
    execFileSync("cargo", ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--no-deps", "--format-version", "1"], { cwd: root, stdio: "ignore" });
  } else if (command === "version") { releaseNotes(root, tag); injectVersion(root, tag); }
  else if (command === "collect") collect(root, tag, triple);
  else if (command === "manifest") {
    const notes = releaseNotes(root, tag) + downloadGuide;
    const output = join(root, "release-output");
    writeFileSync(join(output, "latest.json"), JSON.stringify(manifest(output, tag, notes), null, 2) + "\n");
    writeFileSync(join(root, ".generated/release-notes.md"), notes);
  } else throw new Error("用法：node scripts/release.mjs prepare|collect|manifest vX.Y.Z [target]");
}
