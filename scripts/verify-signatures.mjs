import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "release-output");
const manifest = JSON.parse(readFileSync(join(directory, "latest.json"), "utf8"));
const publicKey = Buffer.from(process.env.TAURI_UPDATER_PUBLIC_KEY ?? "", "base64").toString().trim().split(/\r?\n/).at(-1);
if (!publicKey) throw new Error("缺少更新公钥");
mkdirSync(join(root, ".generated"), { recursive: true });
for (const [target, entry] of Object.entries(manifest.platforms)) {
  const filename = new URL(entry.url).pathname.split("/").at(-1);
  const signature = join(root, ".generated", `${target}.minisig`);
  writeFileSync(signature, Buffer.from(entry.signature, "base64"));
  execFileSync("minisign", ["-Vm", join(directory, filename), "-P", publicKey, "-x", signature], { stdio: "inherit" });
}
