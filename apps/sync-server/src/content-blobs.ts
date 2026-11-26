import { SyncError, type operation } from "./protocol.js";
import { query, type BlobStore, type Database } from "./storage.js";

// Blob adapters verify checksum and length at upload. Read Markdown as a
// bounded stream before the entity transaction; binary image blobs stay binary.
export async function validateContentBlobs(db: Database, blobs: BlobStore, input: ReturnType<typeof operation>) {
  const checked = new Set<string>();
  for (const mutation of input.mutations) {
    const data = mutation.payload;
    if (mutation.entityType !== "entry" && !(mutation.entityType === "collection_node" && data?.kind === "text")) continue;
    if (!data || typeof data.contentBlobHash !== "string") continue;
    const hash = data.contentBlobHash, size = data.contentBlobSize;
    const [stored] = await query<{ size_bytes: number }>(db, ["SELECT size_bytes FROM sync_blobs WHERE sha256=?", hash]);
    // Missing dependencies use the existing transactional rejection receipt.
    if (!stored) continue;
    if (stored.size_bytes !== size) throw new SyncError(400, "invalid_content_blob", undefined, "contentBlobSize");
    if (checked.has(hash)) continue;
    const stream = await blobs.get(hash).catch(() => {
      throw new SyncError(503, "blob_storage_unavailable", undefined, "contentBlobHash");
    });
    if (!stream) throw new SyncError(503, "blob_unavailable");
    const reader = stream.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read().catch(() => {
          throw new SyncError(503, "blob_storage_unavailable", undefined, "contentBlobHash");
        });
        if (done) break;
        received += value.byteLength;
        if (received > stored.size_bytes) throw new SyncError(422, "blob_length_mismatch");
        try { decoder.decode(value, { stream: true }); }
        catch (error) {
          if (!(error instanceof TypeError)) throw error;
          throw new SyncError(422, "invalid_content_utf8", undefined, "contentBlobHash");
        }
      }
      if (received !== stored.size_bytes) throw new SyncError(422, "blob_length_mismatch");
      try { decoder.decode(); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new SyncError(422, "invalid_content_utf8", undefined, "contentBlobHash");
      }
    } finally {
      try {
        await reader.cancel().catch(() => {
          throw new SyncError(503, "blob_storage_unavailable", undefined, "contentBlobHash");
        });
      } finally { reader.releaseLock(); }
    }
    checked.add(hash);
  }
}
