// Isolated local test entrypoint; never imported by the production Worker.
import { d1Database, type D1Binding } from "../src/adapters/d1.js";
import { r2Blobs, type R2Binding } from "../src/adapters/r2.js";
import { gcFeed, gcCheckpoint, gcBeginDelete } from "../src/image-gc.js";
import { putManagedPrivate, gcRunPrivateJob, gcRestorePrivate, gcExpirePrivate, privateLocation } from "../src/image-gc-store.js";
import { reservePublic,commitPublic,backupPublic,completePublic,publicBackup,restoredPublic,expirePublic } from "../src/image-gc-s3.js";
import { SyncError } from "../src/protocol.js";
import type { Client } from "../src/sync.js";
import type { Statement } from "../src/storage.js";

type Env = { DB: D1Binding; BLOBS: R2Binding; GC_TEST_TOKEN: string };
export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.get("Authorization") !== `Bearer ${env.GC_TEST_TOKEN}`) return new Response(null, { status: 403 });
    const db = d1Database(env.DB), store = r2Blobs(env.BLOBS);
    const action = new URL(request.url).pathname;
    try {
      if (action === "/sql") return Response.json(await db.batch(await request.json() as Statement[]));
      if (action === "/put") {
        const client = JSON.parse(request.headers.get("X-Test-Client")!) as Client;
        return Response.json(await putManagedPrivate(db, store, client, request.headers.get("X-Test-Hash")!, Number(request.headers.get("Content-Length")), request.body!));
      }
      const input = await request.json() as { client: Client; hash: string; jobId: string; copyId: string; roundId: string; timestamp: number };
      if (action === "/public-reserve") return Response.json(await reservePublic(db,input.client,input as unknown as Record<string,unknown>));
      if (action === "/public-commit") return Response.json(await commitPublic(db,input.client,input as unknown as Record<string,unknown>));
      if (action === "/public-backup") {
        const encoded=(input as unknown as {encoded:string}).encoded;
        return Response.json(await backupPublic(db,store,input.client,input.jobId,new Response(Uint8Array.from(atob(encoded),value=>value.charCodeAt(0))).body!));
      }
      if (action === "/public-complete") return Response.json(await completePublic(db,input.client,input as unknown as Record<string,unknown>));
      if (action === "/public-read") return Response.json(Array.from(await publicBackup(db,store,input.client,input.jobId)));
      if (action === "/public-restored") return Response.json(await restoredPublic(db,input.client,input as unknown as Record<string,unknown>));
      if (action === "/public-expire") return Response.json(await expirePublic(db,store,input.client,input.jobId));
      if (action === "/feed") return Response.json(await gcFeed(db, input.client, input.timestamp));
      if (action === "/checkpoint") return Response.json(await gcCheckpoint(db, input.client, input as unknown as Record<string, unknown>));
      if (action === "/begin") return Response.json(await gcBeginDelete(db, input.client, input.copyId, input.roundId, input.timestamp));
      if (action === "/run") return Response.json(await gcRunPrivateJob(db, store, input.client, input.jobId, input.timestamp));
      if (action === "/restore") return Response.json(await gcRestorePrivate(db, store, input.client, input.hash));
      if (action === "/expire") return Response.json(await gcExpirePrivate(db, store, input.client, input.jobId, input.timestamp));
      if (action === "/location") return Response.json(await privateLocation(db, input.hash));
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof SyncError) return Response.json({ error: error.code }, { status: error.status });
      throw error;
    }
  },
};
