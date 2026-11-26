// Opt-in upload (spec §7). Called only from the "Send to BBQlaw" tap.
import type { CaptureDocument } from './capture';

export const CAPTURES_URL = 'https://bbqlaw.app/api/captures';
export const UPLOAD_LIMIT_BYTES = 512 * 1024;
const TIMEOUT_MS = 30_000;

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const c of text) {
    const code = c.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** The server accepts 512 KB. A longer capture drops its latest events from the upload only. */
export function uploadBody(document: CaptureDocument): string {
  let events = document.events;
  let body = JSON.stringify(document);
  while (utf8Length(body) > UPLOAD_LIMIT_BYTES && events.length > 0) {
    events = events.slice(0, Math.floor(events.length * 0.9));
    body = JSON.stringify({ ...document, events });
  }
  return body;
}

export type Fetch = typeof fetch;

/** Returns the reference code. */
export async function uploadCapture(document: CaptureDocument, fetcher: Fetch = fetch): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(CAPTURES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: uploadBody(document),
      signal: abort.signal,
    });
    if (response.status === 429) throw new Error('Too many captures sent. Try again in an hour.');
    if (!response.ok) throw new Error(`Send failed (HTTP ${response.status}).`);
    const { code } = (await response.json()) as { code?: unknown };
    if (typeof code !== 'string' || code === '') throw new Error('Send failed: no reference code.');
    return code;
  } finally {
    clearTimeout(timer);
  }
}
