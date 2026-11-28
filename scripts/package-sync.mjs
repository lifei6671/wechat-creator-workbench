import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion } from "./release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = releaseVersion(process.argv[2]);
const source = join(root, "apps/sync-server");
const output = join(root, "release-output");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd) {
  // npm.cmd is invoked through the native shell only with fixed, local arguments.
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && command.endsWith(".cmd") });
}
function packageLicense(path) {
  const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const texts = readdirSync(path).filter(name => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(name) && statSync(join(path, name)).isFile())
    .map(name => readFileSync(join(path, name), "utf8")).join("\n\n");
  return { name: pkg.name, version: pkg.version, license: pkg.license ?? "未标明", text: texts };
}
function dependencyLicenses(entries) {
  const packages = new Map();
  for (const entry of entries) {
    let folder = dirname(entry);
    while (!readdirSync(folder).includes("package.json")) {
      const parent = dirname(folder);
      if (parent === folder) throw new Error(`无法定位组件：${entry}`);
      folder = parent;
    }
    const pkg = packageLicense(folder);
    packages.set(`${pkg.name}:${pkg.version}`, pkg);
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}
mkdirSync(output, { recursive: true });
for (const platform of ["cloudflare", "vps"]) {
  const name = `CreatorWorkbench-${version}-sync-${platform}`;
  const directory = join(root, ".generated", name);
  mkdirSync(directory, { recursive: true });
  cpSync(join(source, "migrations"), join(directory, "migrations"), { recursive: true });
  cpSync(join(root, "LICENSE"), join(directory, "LICENSE"));
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (pkg.version !== version) throw new Error("请先注入统一版本");
  pkg.scripts = platform === "vps" ? { start: "node dist/node.js" }
    : { deploy: "wrangler d1 migrations apply DB --remote && wrangler deploy", "recovery:cloudflare": "node scripts/cloudflare-recovery.mjs" };
  if (platform === "vps") delete pkg.devDependencies;
  else { pkg.dependencies = {}; pkg.devDependencies = { wrangler: pkg.devDependencies.wrangler }; }
  writeFileSync(join(directory, "package.json"), JSON.stringify(pkg, null, 2));
  cpSync(join(source, "package-lock.json"), join(directory, "package-lock.json"));
  run(npm, ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], directory);
  let licenses;
  if (platform === "cloudflare") {
    const worker = join(directory, "worker");
    // Explicit checked-in template: never read the operator's ignored production config.
    run(process.execPath, [join(source, "node_modules/wrangler/bin/wrangler.js"), "deploy", "--config", "wrangler.jsonc",
      "--dry-run", "--outdir", worker, "--metafile", join(directory, "worker-meta.json")], source);
    const meta = JSON.parse(readFileSync(join(directory, "worker-meta.json"), "utf8"));
    unlinkSync(join(directory, "worker-meta.json"));
    licenses = dependencyLicenses(Object.keys(meta.inputs).filter(path => path.includes("node_modules/")).map(path => resolve(source, path)));
    const config = JSON.parse(readFileSync(join(source, "wrangler.jsonc"), "utf8"));
    config.main = "worker/cloudflare.js";
    config.no_bundle = true;
    writeFileSync(join(directory, "wrangler.jsonc"), JSON.stringify(config, null, 2));
    mkdirSync(join(directory, "scripts"), { recursive: true });
    cpSync(join(source, "scripts/cloudflare-recovery.mjs"), join(directory, "scripts/cloudflare-recovery.mjs"));
  } else {
    cpSync(join(source, "dist"), join(directory, "dist"), { recursive: true });
    const dependencyPaths = [];
    function visit(dependencies) {
      for (const dependency of Object.values(dependencies ?? {})) {
        if (dependency.path) dependencyPaths.push(join(dependency.path, "package.json"));
        visit(dependency.dependencies);
      }
    }
    const tree = JSON.parse(execFileSync(npm, ["ls", "--omit=dev", "--all", "--json", "--long"], {
      cwd: source, encoding: "utf8", shell: process.platform === "win32",
    }));
    visit(tree.dependencies); licenses = dependencyLicenses(dependencyPaths);
    cpSync(join(source, "compose.yaml"), join(directory, "compose.yaml"));
    cpSync(join(root, "scripts/release-templates/Dockerfile"), join(directory, "Dockerfile"));
    writeFileSync(join(directory, ".env.example"), "SETUP_SECRET=\nSYNC_PORT=8787\n");
  }
  writeFileSync(join(directory, "third-party.json"), JSON.stringify(licenses, null, 2));
  writeFileSync(join(directory, "version.json"), JSON.stringify({ version, commit: process.env.GITHUB_SHA
    || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), protocol: 3, platform }, null, 2));
  cpSync(join(root, `scripts/release-templates/${platform}.md`), join(directory, "README.md"));
  run("tar", ["-czf", join(output, name + ".tar.gz"), "-C", dirname(directory), name], root);
}
