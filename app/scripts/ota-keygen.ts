// Creates the OTA signing key and its self-signed certificate. Run once.
//   node --experimental-strip-types scripts/ota-keygen.ts
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_KEY_PATH = join(homedir(), '.config/bbqlaw/ota-private-key.pem');
export const DEFAULT_CERTIFICATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../updates/certificate.pem');

/**
 * Never overwrites. A new certificate is a new trust root: installed apps accept
 * updates only from the key that matches the certificate embedded in the build.
 */
export async function generateSigningFiles(keyPath: string, certificatePath: string, modulusLength = 4096): Promise<void> {
  for (const path of [keyPath, certificatePath]) {
    if (existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
  }
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  await writeFile(keyPath, privateKey, { mode: 0o600, flag: 'wx' });
  // Match expo-updates codesigning:generate: critical digitalSignature and
  // critical codeSigning EKU, with an explicit non-CA basic constraint.
  const certificate = execFileSync('openssl', [
    'req', '-new', '-x509', '-key', keyPath, '-days', '3650', '-subj', '/CN=Mobile update signing',
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature',
    '-addext', 'extendedKeyUsage=critical,codeSigning',
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  await mkdir(dirname(certificatePath), { recursive: true });
  await writeFile(certificatePath, certificate, { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateSigningFiles(DEFAULT_KEY_PATH, DEFAULT_CERTIFICATE_PATH).then(
    () => process.stdout.write(`Private key: ${DEFAULT_KEY_PATH}\nCertificate: ${DEFAULT_CERTIFICATE_PATH}\nBack up the private key. Commit only the certificate.\n`),
    (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; },
  );
}
