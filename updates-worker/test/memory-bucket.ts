import type { ObjectStore } from "../../app/scripts/publish-ota.ts";
import type { StoredObject, UpdatesBucket } from "../src/store.ts";

/** In-memory bucket with the R2 read shape for the host and the write shape for the publisher. */
export class MemoryBucket implements UpdatesBucket, ObjectStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  readonly writes: string[] = [];

  async put(key: string, bytes: Buffer | string, contentType = "application/json"): Promise<void> {
    this.writes.push(key);
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
  }

  async get(key: string): Promise<(Buffer & StoredObject) | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = Buffer.from(stored.bytes);
    return Object.assign(bytes, {
      size: bytes.length,
      body: new Blob([new Uint8Array(stored.bytes)]).stream() as ReadableStream,
      httpMetadata: { contentType: stored.contentType },
      text: async () => stored.bytes.toString("utf8"),
    });
  }
}
