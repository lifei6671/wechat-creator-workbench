import { equalDigest, hashPattern, invalid, sha256, SyncError, token } from "./protocol.js";
import { query, type Database, type Device } from "./storage.js";

export type DeviceAuthorization = { id: string; tokenHash: string };

export async function authenticate(db: Database, authorization: string | undefined): Promise<DeviceAuthorization> {
  const secret = authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if (!secret) throw new SyncError(401, "invalid_device");
  const tokenHash = await sha256(secret);
  const [device] = await query<{ id: string }>(db, [
    "SELECT id FROM sync_devices WHERE token_hash = ? AND revoked_at IS NULL",
    tokenHash,
  ]);
  if (!device) throw new SyncError(401, "invalid_device");
  return { id: device.id, tokenHash };
}

async function deviceHash(secret: unknown) {
  if (typeof secret !== "string" || !hashPattern.test(secret)) invalid("invalid_device_token");
  return sha256(secret);
}

export async function claim(db: Database, setupSecret: string | undefined, secret: unknown, deviceToken: unknown, name: string) {
  if (!setupSecret || !hashPattern.test(setupSecret)) throw new SyncError(503, "setup_unavailable");
  if (typeof secret !== "string" || !hashPattern.test(secret) ||
      !equalDigest(await sha256(secret), await sha256(setupSecret))) {
    throw new SyncError(401, "invalid_setup_secret");
  }
  const hash = await deviceHash(deviceToken);
  const deviceId = crypto.randomUUID();
  const [, , rows] = await db.batch([
    [`INSERT INTO sync_devices (id, name, token_hash, created_at)
      SELECT ?, ?, ?, ? FROM sync_identity WHERE claimed = 0`, deviceId, name, hash, Date.now()],
    ["UPDATE sync_identity SET claimed = 1, claim_device = ? WHERE EXISTS (SELECT 1 FROM sync_devices WHERE id = ?)", deviceId, deviceId],
    [`SELECT d.id FROM sync_devices d JOIN sync_identity i ON i.claim_device = d.id
      WHERE d.token_hash = ? AND d.revoked_at IS NULL`, hash],
  ]);
  if (rows.length === 0) throw new SyncError(409, "already_claimed");
  return { deviceId: (rows[0] as { id: string }).id };
}

export async function createAccessKey(db: Database, device: DeviceAuthorization) {
  const accessKey = token();
  const [state] = await query<{ id: number }>(db, [
    `UPDATE sync_identity SET access_hash = ?
     WHERE EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND token_hash = ? AND revoked_at IS NULL)
     RETURNING id`,
    await sha256(accessKey), device.id, device.tokenHash,
  ]);
  if (!state) throw new SyncError(401, "invalid_device");
  return { accessKey };
}

export async function join(db: Database, accessKey: unknown, deviceToken: unknown, name: string) {
  if (typeof accessKey !== "string" || !hashPattern.test(accessKey)) throw new SyncError(401, "invalid_access_key");
  const [hash, accessHash] = await Promise.all([deviceHash(deviceToken), sha256(accessKey)]);
  const [, devices] = await db.batch([
    [`INSERT INTO sync_devices (id, name, token_hash, created_at)
      SELECT ?, ?, ?, ? FROM sync_identity WHERE claimed = 1 AND access_hash = ?
      ON CONFLICT(token_hash) DO NOTHING`, crypto.randomUUID(), name, hash, Date.now(), accessHash],
    [`SELECT d.id FROM sync_devices d CROSS JOIN sync_identity s
      WHERE d.token_hash = ? AND d.revoked_at IS NULL AND s.claimed = 1 AND s.access_hash = ?`, hash, accessHash],
  ]);
  if (!devices.length) throw new SyncError(401, "invalid_access_key");
  return { deviceId: (devices[0] as { id: string }).id };
}

export async function createRecoveryKey(db: Database, authorization: DeviceAuthorization) {
  const recoveryKey = token();
  const [device] = await query<{ id: string }>(db, [
    `UPDATE sync_devices SET recovery_hash = ?
     WHERE id = ? AND token_hash = ? AND revoked_at IS NULL RETURNING id`,
    await sha256(recoveryKey), authorization.id, authorization.tokenHash,
  ]);
  if (!device) throw new SyncError(401, "invalid_device");
  return { recoveryKey };
}

export async function recover(db: Database, recoveryKey: unknown, deviceToken: unknown, name: string) {
  if (typeof recoveryKey !== "string" || !hashPattern.test(recoveryKey)) throw new SyncError(401, "invalid_recovery_key");
  const [hash, recoveryHash] = await Promise.all([deviceHash(deviceToken), sha256(recoveryKey)]);
  const [device] = await query<{ id: string }>(db, [
    `UPDATE sync_devices SET name = ?, token_hash = ?, recovery_hash = NULL
     WHERE recovery_hash = ? AND revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM sync_devices WHERE token_hash = ?)
     RETURNING id`,
    name, hash, recoveryHash, hash,
  ]);
  if (!device) throw new SyncError(401, "invalid_recovery_key");
  return { deviceId: device.id };
}

export function listDevices(db: Database) {
  return query<Device>(db, ["SELECT id, name, created_at, revoked_at FROM sync_devices ORDER BY created_at, id"]);
}

export async function revoke(db: Database, actor: DeviceAuthorization, deviceId: string) {
  const [updated, activeActor, target] = await db.batch([
    [`UPDATE sync_devices SET revoked_at = COALESCE(revoked_at, ?), recovery_hash = NULL
      WHERE id = ? AND EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND token_hash = ? AND revoked_at IS NULL)
        AND EXISTS (SELECT 1 FROM sync_devices d WHERE d.id <> ? AND d.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM sync_identity WHERE seed_status = 'seeding' AND seed_device = ?)
      RETURNING id`, Date.now(), deviceId, actor.id, actor.tokenHash, deviceId, deviceId],
    ["SELECT id FROM sync_devices WHERE id = ? AND token_hash = ? AND revoked_at IS NULL", actor.id, actor.tokenHash],
    ["SELECT id FROM sync_devices WHERE id = ?", deviceId],
  ]);
  if (updated.length) return;
  if (!activeActor.length) throw new SyncError(401, "invalid_device");
  if (!target.length) throw new SyncError(404, "device_not_found");
  throw new SyncError(409, "device_required");
}
