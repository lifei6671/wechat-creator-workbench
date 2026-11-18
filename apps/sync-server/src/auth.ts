import { equalDigest, hashPattern, invalid, sha256, SyncError, token } from "./protocol.js";
import { query, type Database, type Device } from "./storage.js";

export async function authenticate(db: Database, authorization: string | undefined): Promise<string> {
  const secret = authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if (!secret) throw new SyncError(401, "invalid_device");
  const [device] = await query<{ id: string }>(db, [
    "SELECT id FROM sync_devices WHERE token_hash = ? AND revoked_at IS NULL",
    await sha256(secret),
  ]);
  if (!device) throw new SyncError(401, "invalid_device");
  return device.id;
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

export async function createPairing(db: Database, deviceId: string) {
  const pairingToken = token();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const [rows] = await db.batch([[
    `INSERT INTO sync_pairings (token_hash, created_by, expires_at)
     SELECT ?, id, ? FROM sync_devices WHERE id = ? AND revoked_at IS NULL RETURNING expires_at`,
    await sha256(pairingToken), expiresAt, deviceId,
  ]]);
  if (!rows.length) throw new SyncError(401, "invalid_device");
  return { pairingToken, expiresAt };
}

export async function redeem(db: Database, secret: unknown, deviceToken: unknown, name: string) {
  if (typeof secret !== "string" || !hashPattern.test(secret)) throw new SyncError(401, "invalid_pairing");
  const pairingHash = await sha256(secret);
  const hash = await deviceHash(deviceToken);
  const deviceId = crypto.randomUUID();
  const now = Date.now();
  const [, , rows] = await db.batch([
    [`UPDATE sync_pairings SET redeemed_by = ?
      WHERE token_hash = ? AND redeemed_by IS NULL AND expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM sync_devices WHERE token_hash = ?)
        AND EXISTS (SELECT 1 FROM sync_devices WHERE id = created_by AND revoked_at IS NULL)`,
      deviceId, pairingHash, now, hash],
    [`INSERT INTO sync_devices (id, name, token_hash, created_at)
      SELECT ?, ?, ?, ? FROM sync_pairings WHERE token_hash = ? AND redeemed_by = ?`,
      deviceId, name, hash, now, pairingHash, deviceId],
    [`SELECT d.id FROM sync_devices d JOIN sync_pairings p ON p.redeemed_by = d.id
      WHERE p.token_hash = ? AND p.expires_at > ? AND d.token_hash = ? AND d.revoked_at IS NULL`,
      pairingHash, now, hash],
  ]);
  if (!rows.length) throw new SyncError(401, "invalid_pairing");
  return { deviceId: (rows[0] as { id: string }).id };
}

export function listDevices(db: Database) {
  return query<Device>(db, ["SELECT id, name, created_at, revoked_at FROM sync_devices ORDER BY created_at, id"]);
}

export async function revoke(db: Database, actorId: string, deviceId: string) {
  const [updated, actor, target] = await db.batch([
    [`UPDATE sync_devices SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? AND EXISTS (SELECT 1 FROM sync_devices WHERE id = ? AND revoked_at IS NULL)
        AND EXISTS (SELECT 1 FROM sync_devices d WHERE d.id <> ? AND d.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM sync_identity WHERE seed_status = 'seeding' AND seed_device = ?)
      RETURNING id`, Date.now(), deviceId, actorId, deviceId, deviceId],
    ["SELECT id FROM sync_devices WHERE id = ? AND revoked_at IS NULL", actorId],
    ["SELECT id FROM sync_devices WHERE id = ?", deviceId],
  ]);
  if (updated.length) return;
  if (!actor.length) throw new SyncError(401, "invalid_device");
  if (!target.length) throw new SyncError(404, "device_not_found");
  throw new SyncError(409, "device_required");
}
