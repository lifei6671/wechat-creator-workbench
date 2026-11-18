import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { localFiles } from "./adapters/local-files.js";
import { openSqlite } from "./adapters/sqlite.js";
import { createApp } from "./app.js";
import { hashPattern } from "./protocol.js";

const setupSecret = process.env.SETUP_SECRET;
if (!setupSecret || !hashPattern.test(setupSecret)) throw new Error("SETUP_SECRET must be a 32-byte hex value");
const data = process.env.DATA_DIR ?? "./data";
await mkdir(data, { recursive: true });
const db = openSqlite(join(data, "sync.db"));
const blobs = await localFiles(join(data, "blobs"));
const app = createApp(db, blobs, setupSecret);
const server = serve({
  fetch: app.fetch,
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? "8787"),
}, ({ port }) => console.log("Sync service listening on port " + port));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => db.close()));
}
