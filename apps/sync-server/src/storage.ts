type SqlValue = number | string | null;
export type Statement = [sql: string, ...bindings: SqlValue[]];

export interface Database {
  batch(statements: Statement[]): Promise<object[][]>;
}

export interface BlobStore {
  put(hash: string, size: number, source: ReadableStream<Uint8Array>): Promise<void>;
  get(hash: string): Promise<ReadableStream<Uint8Array> | null>;
}

export async function query<T>(db: Database, statement: Statement): Promise<T[]> {
  const [rows] = await db.batch([statement]);
  return rows as T[];
}

export type Identity = {
  instance_id: string;
  workspace_id: string;
  epoch: string;
  claimed: number;
  seed_status: "empty" | "seeding" | "ready";
  seed_device: string | null;
  min_cursor: number;
  head_cursor: number;
};

export async function identity(db: Database): Promise<Identity> {
  const [result] = await query<Identity>(db, ["SELECT * FROM sync_watermarks"]);
  return result;
}

export type Device = { id: string; name: string; created_at: number; revoked_at: number | null };
