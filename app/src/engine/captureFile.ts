import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { CaptureDocument } from './capture';

/** Writes the capture to the cache directory. */
export function writeCaptureFile(document: CaptureDocument, fileName: string): File {
  const file = new File(Paths.cache, fileName);
  file.create({ overwrite: true });
  file.write(JSON.stringify(document, null, 2));
  return file;
}

export async function shareCaptureFile(document: CaptureDocument, fileName: string): Promise<void> {
  const file = writeCaptureFile(document, fileName);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json' });
}
