import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { SyncError } from "../protocol.js";
import type { BlobStore } from "../storage.js";

export async function localFiles(directory: string): Promise<BlobStore> {
  await mkdir(directory, { recursive: true });
  return {
    async head(hash) {
      try { return { size: (await stat(join(directory, hash))).size }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async put(hash, size, source) {
      const staged = join(directory, "." + randomUUID());
      const digest = createHash("sha256");
      let received = 0;
      try {
        await pipeline(
          Readable.fromWeb(source as NodeReadableStream<Uint8Array>),
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              received += chunk.length;
              if (received > size) {
                callback(new SyncError(400, "blob_length_mismatch"));
                return;
              }
              digest.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(staged, { flags: "wx", mode: 0o600 }),
        );
        if (received !== size) throw new SyncError(400, "blob_length_mismatch");
        if (digest.digest("hex") !== hash) throw new SyncError(422, "blob_checksum_mismatch");
        await rename(staged, join(directory, hash));
      } finally {
        await rm(staged, { force: true });
      }
    },
    async get(hash) {
      try {
        const file = await open(join(directory, hash));
        return Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}
