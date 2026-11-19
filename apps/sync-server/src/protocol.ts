import type { ContentfulStatusCode } from "hono/utils/http-status";

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const MAX_PUSH_BYTES = MiB;
export const MAX_BLOB_BYTES = 25 * MiB;
export const MAX_PAGE_BYTES = 2 * MiB;
export const MAX_MUTATIONS = 256;
const utf8 = new TextEncoder();
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
export const hashPattern = /^[a-f0-9]{64}$/;

export class SyncError extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: string, readonly reason?: string) {
    super(code);
  }
}

export function invalid(code = "invalid_request"): never {
  throw new SyncError(400, code);
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

export function id(value: unknown): string {
  if (typeof value !== "string" || !identifier.test(value)) invalid("invalid_id");
  return value;
}

export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0") || value !== value.trim() || value.length > max) invalid();
  return value;
}

export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid("invalid_integer");
  return value;
}

export function queryInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) invalid("invalid_integer");
  return integer(Number(value));
}

export function entityType(value: unknown) {
  if (value !== "asset" && value !== "category" && value !== "entry" && value !== "collection"
      && value !== "collection_node" && value !== "collection_edge") invalid("unsupported_entity");
  return value;
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(value)));
  return hex(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function token(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export function equalDigest(left: string, right: string): boolean {
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function mutation(value: unknown) {
  const input = record(value);
  const type = entityType(input.entityType);
  const entityId = id(input.entityId);
  const baseRevision = integer(input.baseRevision);
  const operation = input.operation;
  if (operation !== "upsert" && !(operation === "delete" && type !== "asset")
      && !(operation === "restore" && type === "entry")) {
    invalid("invalid_operation");
  }

  const payload = operation === "delete" && (type !== "entry" || input.payload == null)
    ? null : record(input.payload);
  if (payload && type === "category") {
    text(payload.name, 256);
    if (payload.parentId != null) id(payload.parentId);
  }
  if (payload && type === "entry") {
    const kind = payload.kind;
    if (kind !== "article" && kind !== "idea" && kind !== "reference") invalid("invalid_entry_kind");
    if (typeof payload.title !== "string") invalid("invalid_entry_title");
    if (payload.categoryId != null) id(payload.categoryId);
    if (payload.coverAssetId != null) id(payload.coverAssetId);
    for (const references of [payload.sourceEntryIds, payload.assetIds]) {
      if (references === undefined) continue;
      if (!Array.isArray(references)) invalid("invalid_references");
      references.forEach(id);
    }
    markdown(payload, "invalid_entry_content");
  }
  if (payload && type === "asset") {
    if (typeof payload.name !== "string" || !["original", "derived"].includes(String(payload.kind))) invalid("invalid_asset");
    if (payload.sha256 !== null) {
      if (typeof payload.sha256 !== "string" || !hashPattern.test(payload.sha256) ||
          integer(payload.bytes) > MAX_BLOB_BYTES ||
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(payload.mimeType))) {
        invalid("invalid_asset_blob");
      }
    }
  }
  if (payload && type === "collection") {
    if (typeof payload.title !== "string" || !payload.title.trim() || typeof payload.description !== "string") invalid("invalid_collection");
    integer(payload.createdAt);
    integer(payload.updatedAt);
    // Viewport values are device preferences and never belong in the cloud snapshot.
    if (["viewport", "viewportX", "viewportY", "viewportZoom"].some(key => key in payload)) invalid("invalid_collection");
  }
  if (payload && type === "collection_node") canvasNode(payload);
  if (payload && type === "collection_edge") {
    id(payload.collectionId);
    if (id(payload.sourceNodeId) === id(payload.targetNodeId) || typeof payload.label !== "string" ||
        [...payload.label].length > 120 || /[\r\n]/.test(payload.label)) invalid("invalid_canvas_edge");
    integer(payload.createdAt);
  }
  if (utf8.encode(JSON.stringify(payload)).byteLength > 512 * KiB) throw new SyncError(413, "entity_too_large");
  return { entityType: type, entityId, baseRevision, operation, payload };
}

function markdown(payload: Record<string, unknown>, invalidContent: string) {
  if (payload.contentBlobHash === undefined) {
    if (typeof payload.contentMd !== "string") invalid(invalidContent);
    if (utf8.encode(payload.contentMd).byteLength >= 64 * KiB) throw new SyncError(413, "content_requires_blob");
  } else if (typeof payload.contentBlobHash !== "string" || !hashPattern.test(payload.contentBlobHash) ||
      payload.contentMd !== undefined || integer(payload.contentBlobSize) > MAX_BLOB_BYTES) {
    invalid("invalid_content_blob");
  }
}

function canvasNode(payload: Record<string, unknown>) {
  id(payload.collectionId);
  integer(payload.createdAt);
  integer(payload.updatedAt);
  if (typeof payload.x !== "number" || !Number.isFinite(payload.x) || typeof payload.y !== "number" || !Number.isFinite(payload.y) ||
      typeof payload.width !== "number" || !(payload.width >= 1 && payload.width <= 1200) ||
      typeof payload.height !== "number" || !(payload.height >= 1 && payload.height <= 1000)) invalid("invalid_canvas_geometry");
  if (payload.color != null && (typeof payload.color !== "string" || !["red", "orange", "amber", "green", "blue", "violet"].includes(payload.color))) invalid("invalid_canvas_color");
  if (payload.customColor != null && (typeof payload.customColor !== "string" || !/^#[a-fA-F0-9]{6}$/.test(payload.customColor))) invalid("invalid_canvas_color");
  if (payload.kind === "entry") id(payload.entryId);
  else if (payload.kind === "image") id(payload.assetId);
  else if (payload.kind === "web") {
    const url = payload.externalUrl;
    if (typeof url !== "string" || !/^https?:\/\/[^/\\\s]/i.test(url) || /\s/.test(url) || !URL.canParse(url)) invalid("invalid_canvas_url");
  } else if (payload.kind === "text") {
    markdown(payload, "invalid_canvas_content");
    if (payload.assetIds !== undefined) {
      if (!Array.isArray(payload.assetIds)) invalid("invalid_references");
      payload.assetIds.forEach(id);
    }
  } else invalid("invalid_canvas_node");
  if ((payload.kind !== "entry" && payload.entryId != null) || (payload.kind !== "image" && payload.assetId != null) ||
      (payload.kind !== "web" && payload.externalUrl != null) || (payload.kind !== "text" &&
        (payload.contentMd !== "" || payload.contentBlobHash !== undefined || payload.assetIds !== undefined))) invalid("invalid_canvas_node");
}

export function operation(value: unknown) {
  const input = record(value);
  const operationId = id(input.operationId);
  if (!Array.isArray(input.mutations) || input.mutations.length === 0 || input.mutations.length > MAX_MUTATIONS) {
    invalid("invalid_mutation_count");
  }
  const mutations = input.mutations.map(mutation);
  const keys = new Set(mutations.map(({ entityType, entityId }) => entityType + "/" + entityId));
  if (keys.size !== mutations.length) invalid("duplicate_entity");
  return { operationId, mutations };
}
