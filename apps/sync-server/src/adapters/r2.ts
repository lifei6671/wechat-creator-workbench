import { SyncError } from "../protocol.js";
import type { BlobStore } from "../storage.js";

export type R2Binding = {
  head(hash: string): Promise<{ size: number } | null>;
  put(hash: string, source: ReadableStream<Uint8Array>, options: { sha256: string }): Promise<{ size: number }>;
  get(hash: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
};

export function r2Blobs(bucket: R2Binding): BlobStore {
  return {
    head: hash => bucket.head(hash),
    async put(hash, size, source) {
      try {
        const result = await bucket.put(hash, source, { sha256: hash });
        if (result.size !== size) throw new SyncError(400, "blob_length_mismatch");
      } catch (error) {
        if (error instanceof Error && /checksum|digest/i.test(error.message)) {
          throw new SyncError(422, "blob_checksum_mismatch");
        }
        throw error;
      }
    },
    async get(hash) {
      return (await bucket.get(hash))?.body ?? null;
    },
  };
}
