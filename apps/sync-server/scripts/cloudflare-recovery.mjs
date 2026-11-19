import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const recoveryLifetimeSeconds = 15 * 60;

export function listRecoveryDevices(execute) {
  return execute(`SELECT id, name, created_at AS createdAt FROM sync_devices
    WHERE revoked_at IS NULL AND EXISTS (SELECT 1 FROM sync_identity WHERE claimed = 1)
    ORDER BY created_at, id`);
}

export async function issueRecoveryKey(execute, deviceId) {
  if (typeof deviceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId)) {
    throw new Error("设备 ID 无效，请先运行 --list 核对。");
  }
  const recoveryKey = randomBytes(32).toString("hex");
  const digest = createHash("sha256").update(recoveryKey).digest("hex");
  const [device] = await execute(`UPDATE sync_devices
    SET admin_recovery_hash = '${digest}', admin_recovery_expires_at = unixepoch() + ${recoveryLifetimeSeconds}
    WHERE id = '${deviceId}' AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM sync_identity WHERE claimed = 1)
    RETURNING admin_recovery_expires_at AS expiresAt`);
  if (!device) throw new Error("找不到可恢复的设备，请核对当前 Wrangler 配置和设备 ID。");
  return { recoveryKey, expiresAt: device.expiresAt };
}

function executeRemote(sql) {
  const require = createRequire(import.meta.url);
  const manifest = "wrangler/package.json";
  const wrangler = resolve(dirname(require.resolve(manifest)), require(manifest).bin.wrangler);
  const output = execFileSync(process.execPath, [wrangler, "d1", "execute", "DB", "--remote", "--json",
    "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const [result] = JSON.parse(output);
  if (!result?.success || !Array.isArray(result.results)) throw new Error("D1 没有返回有效结果。");
  return result.results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 1) throw new Error("用法为 npm run recovery:cloudflare -- --list 或 npm run recovery:cloudflare -- <设备 ID>");
    if (args[0] === "--list") {
      console.log(JSON.stringify(await listRecoveryDevices(executeRemote), null, 2));
    } else {
      const { recoveryKey, expiresAt } = await issueRecoveryKey(executeRemote, args[0]);
      console.log(recoveryKey);
      console.error(`恢复密钥在 ${new Date(expiresAt * 1000).toISOString()} 到期（UTC），仅可使用一次。`);
    }
  } catch (error) {
    console.error(error.stderr?.toString().trim() || error.message);
    process.exitCode = 1;
  }
}
