/** The part of R2Bucket that the host reads. R2Bucket satisfies it. */
export interface UpdatesBucket {
  get(key: string): Promise<StoredObject | null>;
}

export interface StoredObject {
  size: number;
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
  text(): Promise<string>;
}

const METADATA_LIMIT = 1024 * 1024;

/** Reads a release envelope or a channel pointer. Returns null when it does not exist. */
export async function readJson(bucket: UpdatesBucket, key: string): Promise<unknown | null> {
  const file = await bucket.get(key);
  if (file === null) return null;
  // Never buffer an unbounded object through the public manifest route.
  if (file.size > METADATA_LIMIT) throw new Error("Update metadata exceeds limit");
  return JSON.parse(await file.text()) as unknown;
}
