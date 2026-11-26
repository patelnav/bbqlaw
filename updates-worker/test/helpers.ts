import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningFiles } from "../../app/scripts/ota-keygen.ts";
import { loadSigner, type Signer } from "../../app/scripts/publish-ota.ts";

export const CONFIGURATION = { name: "BBQlaw", updates: { url: "https://updates.bbqlaw.app/manifest" } };

/** A throwaway key and certificate, made by the real keygen script. */
export async function throwawaySigner(directory: string): Promise<{ signer: Signer; keyPath: string; certificatePath: string }> {
  const keyPath = join(directory, "private", "key.pem");
  const certificatePath = join(directory, "updates", "certificate.pem");
  await generateSigningFiles(keyPath, certificatePath, 2048);
  const signer = loadSigner(await readFile(keyPath, "utf8"), await readFile(certificatePath));
  return { signer, keyPath, certificatePath };
}

/** The directory layout that `expo export --platform ios` writes. */
export async function writeExport(directory: string, bundle: string): Promise<void> {
  await mkdir(join(directory, "_expo/static/js/ios"), { recursive: true });
  await mkdir(join(directory, "assets"), { recursive: true });
  await writeFile(join(directory, "_expo/static/js/ios/entry-abc.hbc"), bundle);
  await writeFile(join(directory, "assets/0123abc"), "font-bytes");
  await writeFile(join(directory, "metadata.json"), JSON.stringify({
    version: 0, bundler: "metro",
    fileMetadata: { ios: { bundle: "_expo/static/js/ios/entry-abc.hbc", assets: [{ path: "assets/0123abc", ext: "ttf" }] } },
  }));
}

export async function temporaryDirectory(): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "bbqlaw-ota-test-"));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}
