import { operation, SyncError } from "./protocol.js";
import { query, type BlobStore, type Database } from "./storage.js";
import { validateContentBlobs } from "./content-blobs.js";

export async function diagnoseEntities(db: Database, blobs: BlobStore, afterType: string, afterId: string) {
  const rows = await query<{ entity_type: string; entity_id: string; revision: number; payload_json: string; deleted_at: number | null }>(db,
    ["SELECT entity_type,entity_id,revision,payload_json,deleted_at FROM sync_entities WHERE (entity_type,entity_id)>(?,?) ORDER BY entity_type,entity_id LIMIT 101", afterType, afterId]);
  const issues: { entityType: string; entityId: string; remoteRevision: number; error: string; field?: string }[] = [];
  for (const row of rows.slice(0, 100)) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(row.payload_json); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      issues.push({ entityType: row.entity_type, entityId: row.entity_id, remoteRevision: row.revision, error: "invalid_payload", field: "$" });
      continue;
    }
    try {
      const input = operation({ operationId: "diagnostic", mutations: [{ entityType: row.entity_type, entityId: row.entity_id,
        baseRevision: row.revision, operation: row.deleted_at === null ? "upsert" : "delete", payload: data }] });
      const blobField = row.entity_type === "asset" ? "sha256"
        : row.entity_type === "entry" || row.entity_type === "collection_node" && data.kind === "text" ? "contentBlobHash" : undefined;
      if (blobField && typeof data[blobField] === "string") {
        const [blob] = await query<{ size_bytes: number }>(db, ["SELECT size_bytes FROM sync_blobs WHERE sha256=?", data[blobField]]);
        if (!blob) throw new SyncError(422, "blob_missing", undefined, blobField);
        if (blob.size_bytes !== data[blobField === "sha256" ? "bytes" : "contentBlobSize"]) throw new SyncError(422, "blob_length_mismatch", undefined, blobField);
        let object;
        try { object = await blobs.head(data[blobField] as string); }
        catch { throw new SyncError(503, "blob_storage_unavailable", undefined, blobField); }
        if (!object) throw new SyncError(422, "blob_object_missing", undefined, blobField);
        if (object.size !== blob.size_bytes) throw new SyncError(422, "blob_object_size_mismatch", undefined, blobField);
      }
      await validateContentBlobs(db, blobs, input);
      if (row.deleted_at === null || row.entity_type === "entry") {
        const refs: { type: string; id: unknown; active: boolean; error: string; field: string }[] = [];
        const add = (type: string, id: unknown, active: boolean, error: string, field: string) => {
          if (id != null) refs.push({ type, id, active, error, field });
        };
        if (row.entity_type === "category") add("category", data.parentId, true, "category_missing", "parentId");
        if (row.entity_type === "entry") {
          add("category", data.categoryId, true, "category_missing", "categoryId");
          add("asset", data.coverAssetId, false, "asset_missing", "coverAssetId");
          for (const id of data.sourceEntryIds as string[] ?? []) add("entry", id, false, "source_entry_missing", "sourceEntryIds");
        }
        if (row.entity_type === "entry" || row.entity_type === "collection_node") {
          for (const id of data.assetIds as string[] ?? []) add("asset", id, false, "asset_missing", "assetIds");
        }
        if (row.entity_type === "collection_node" || row.entity_type === "collection_edge") {
          add("collection", data.collectionId, true, "collection_missing", "collectionId");
          add("entry", data.entryId, false, "source_entry_missing", "entryId");
          add("asset", data.assetId, false, "asset_missing", "assetId");
          for (const field of ["sourceNodeId", "targetNodeId"]) add("collection_node", data[field], true, "canvas_endpoint_missing", field);
        }
        const [missing] = await query<{ error: string; field: string }>(db, [
          `SELECT ref.value->>'$.error' AS error,ref.value->>'$.field' AS field FROM json_each(?) ref
           LEFT JOIN sync_entities e ON (e.entity_type,e.entity_id)=(ref.value->>'$.type',ref.value->>'$.id')
           WHERE e.entity_id IS NULL OR (ref.value->>'$.active' AND e.deleted_at IS NOT NULL)
             OR (ref.value->>'$.type'='collection_node' AND e.payload_json->>'$.collectionId' IS NOT ?) LIMIT 1`, JSON.stringify(refs), typeof data.collectionId === "string" ? data.collectionId : null,
        ]);
        if (missing) throw new SyncError(422, missing.error, undefined, missing.field);
      }
    } catch (error) {
      if (!(error instanceof SyncError)) throw error;
      issues.push({ entityType: row.entity_type, entityId: row.entity_id, remoteRevision: row.revision, error: error.code, ...error.field ? { field: error.field } : {} });
    }
  }
  const last = rows[Math.min(rows.length, 100) - 1];
  return { checked: Math.min(rows.length, 100), issues,
    nextAfter: rows.length > 100 ? { entityType: last.entity_type, entityId: last.entity_id } : null };
}
