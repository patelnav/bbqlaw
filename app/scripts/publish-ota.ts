// Publishes signed Expo Updates (iOS only) to the R2 bucket behind updates-worker.
// Operator commands: see README-ota.md.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, randomUUID, sign, verify, X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_CERTIFICATE_PATH, DEFAULT_KEY_PATH } from './ota-keygen.ts';

const APP_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = resolve(APP_DIRECTORY, '../updates-worker/node_modules/.bin/wrangler');
const BUCKET = 'bbqlaw-updates';
export const ORIGIN = 'https://updates.bbqlaw.app';

export type Channel = 'preview' | 'production';
export type Asset = { key: string; hash: string; url: string; contentType: string; fileExtension?: string };
export type Manifest = {
  id: string; createdAt: string; runtimeVersion: string; launchAsset: Asset; assets: Asset[];
  metadata: Record<string, string>; extra: Record<string, unknown>;
};
export type Upload = { key: string; bytes: Buffer; contentType: string };
export interface ObjectStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
}
export type Signer = { certificate: Buffer; sign(body: string): string };

const TOKEN_CHARACTERS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ._-';

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
      [...value].some(character => !TOKEN_CHARACTERS.includes(character))) {
    throw new Error('Invalid update id or runtime version');
  }
  return value;
}
export function channelName(value: unknown): Channel {
  if (value !== 'preview' && value !== 'production') throw new Error('Channel must be preview or production');
  return value;
}
const pointerKey = (channel: Channel, runtime: string) => `pointers/${channelName(channel)}/ios/${identifier(runtime)}.json`;
const releaseKey = (id: string) => `releases/${identifier(id)}/ios.json`;

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', wav: 'audio/wav',
  mp4: 'video/mp4', json: 'application/json', hbc: 'application/javascript', js: 'application/javascript',
};

export function loadSigner(privateKeyPem: string, certificate: Buffer, now = Date.now()): Signer {
  const parsed = new X509Certificate(certificate);
  if (parsed.ca || !parsed.keyUsage?.includes('1.3.6.1.5.5.7.3.3')) throw new Error('OTA certificate must be a non-CA code-signing certificate');
  if (Date.parse(parsed.validTo) <= now || Date.parse(parsed.validFrom) > now + 60_000) throw new Error('OTA certificate is outside its validity period');
  if (!parsed.checkPrivateKey(createPrivateKey(privateKeyPem))) throw new Error('Private key does not match the OTA certificate');
  return { certificate, sign: body => sign('RSA-SHA256', Buffer.from(body), privateKeyPem).toString('base64') };
}

async function readExportFile(directory: string, path: string): Promise<Buffer> {
  const root = resolve(directory);
  const absolute = resolve(root, path);
  if (!absolute.startsWith(root + sep)) throw new Error(`Export path escapes the output directory: ${path}`);
  return readFile(absolute);
}

export type BuildInput = {
  exportDirectory: string; configuration: Record<string, unknown>; runtimeVersion: string;
  id: string; createdAt: string; origin?: string;
};

/** Turns an `expo export` directory into a manifest and the files that it names. */
export async function buildManifest(input: BuildInput): Promise<{ manifest: Manifest; uploads: Upload[] }> {
  const origin = input.origin ?? ORIGIN;
  const updateUrl = (input.configuration.updates as { url?: unknown } | undefined)?.url;
  if (updateUrl !== `${origin}/manifest`) throw new Error(`app.config updates.url must be ${origin}/manifest`);
  const metadata = JSON.parse((await readExportFile(input.exportDirectory, 'metadata.json')).toString('utf8')) as {
    fileMetadata?: { ios?: { bundle?: string; assets?: { path: string; ext: string }[] } };
  };
  const ios = metadata.fileMetadata?.ios;
  if (!ios?.bundle || !Array.isArray(ios.assets)) throw new Error('Export has no iOS metadata');
  const uploads = new Map<string, Upload>();
  const asset = async (path: string, extension: string, launch: boolean): Promise<Asset> => {
    const bytes = await readExportFile(input.exportDirectory, path);
    const digest = createHash('sha256').update(bytes).digest();
    const hex = digest.toString('hex');
    const contentType = MEDIA_TYPES[extension] ?? 'application/octet-stream';
    uploads.set(hex, { key: `assets/${hex}`, bytes, contentType });
    // Metro resolves regular assets by their exported file name, not by the
    // SHA-256 hash that storage and integrity checks use.
    return {
      key: basename(path, extname(path)), hash: digest.toString('base64url'), contentType,
      url: `${origin}/assets/${hex}`, ...(launch ? {} : { fileExtension: `.${extension}` }),
    };
  };
  const launchAsset = await asset(ios.bundle, 'js', true);
  const assets: Asset[] = [];
  for (const item of ios.assets) assets.push(await asset(item.path, item.ext, false));
  return {
    manifest: {
      id: identifier(input.id), createdAt: input.createdAt, runtimeVersion: identifier(input.runtimeVersion),
      launchAsset, assets, metadata: {}, extra: { expoClient: input.configuration },
    },
    uploads: [...uploads.values()],
  };
}

async function readObject(store: ObjectStore, key: string): Promise<Record<string, unknown> | null> {
  const bytes = await store.get(key);
  return bytes === null ? null : JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
}
function putJson(store: ObjectStore, key: string, value: unknown): Promise<void> {
  return store.put(key, Buffer.from(JSON.stringify(value)), 'application/json');
}
function verified(certificate: Buffer, body: unknown, signature: unknown): string {
  if (typeof body !== 'string' || typeof signature !== 'string' ||
      !verify('RSA-SHA256', Buffer.from(body), certificate, Buffer.from(signature, 'base64'))) {
    throw new Error('Stored update signature is invalid');
  }
  return body;
}
/** A stored release, accepted only when it is signed by the current certificate. */
export async function readRelease(store: ObjectStore, certificate: Buffer, id: string): Promise<Manifest> {
  const envelope = await readObject(store, releaseKey(id));
  if (!envelope) throw new Error(`Update not found: ${id}`);
  const manifest = JSON.parse(verified(certificate, envelope.manifest, envelope.signature)) as Manifest;
  if (manifest.id !== id) throw new Error('Stored update id mismatch');
  return manifest;
}

async function writeRelease(store: ObjectStore, signer: Signer, channel: Channel, manifest: Manifest): Promise<void> {
  const body = JSON.stringify(manifest);
  await putJson(store, releaseKey(manifest.id), { manifest: body, signature: signer.sign(body), keyid: 'root' });
  // The pointer moves last, so the host never names a release that is incomplete.
  await putJson(store, pointerKey(channel, manifest.runtimeVersion), { release: manifest.id });
}

export async function publishUpdate(store: ObjectStore, signer: Signer, channel: Channel, input: BuildInput): Promise<Manifest> {
  const { manifest, uploads } = await buildManifest(input);
  for (const upload of uploads) await store.put(upload.key, upload.bytes, upload.contentType);
  await writeRelease(store, signer, channel, manifest);
  return manifest;
}

/** Points `to` at the release that `from` serves for the same runtime. */
export async function promoteUpdate(
  store: ObjectStore, certificate: Buffer,
  options: { from: Channel; to: Channel; runtimeVersion: string; targetRuntimeVersion: string },
): Promise<string> {
  const { from, to, runtimeVersion, targetRuntimeVersion } = options;
  if (from === to) throw new Error('--from and --to must differ');
  if (runtimeVersion !== targetRuntimeVersion) {
    // A copied pointer would never be requested by the target channel's builds.
    throw new Error(`Runtime versions differ: ${from}=${runtimeVersion} ${to}=${targetRuntimeVersion}. Run "publish --channel ${to}" from the same commit instead.`);
  }
  const source = await readObject(store, pointerKey(from, runtimeVersion));
  if (!source) throw new Error(`Nothing is published on ${from} for runtime ${runtimeVersion}`);
  if (typeof source.release !== 'string') throw new Error(`${from} serves a rollback directive. Use "embedded --channel ${to}".`);
  const next = await readRelease(store, certificate, source.release);
  if (next.runtimeVersion !== runtimeVersion) throw new Error('Release runtime mismatch');
  const current = await readObject(store, pointerKey(to, runtimeVersion));
  if (current && current.release !== next.id) {
    const time = typeof current.release === 'string'
      ? (await readRelease(store, certificate, current.release)).createdAt
      : (JSON.parse(verified(certificate, current.directive, current.signature)) as { parameters: { commitTime: string } }).parameters.commitTime;
    // Installed apps apply only an update that is newer than the one they run.
    if (!(Date.parse(next.createdAt) > Date.parse(time))) {
      throw new Error(`Promotion must be newer than the update that ${to} serves. Use rollback to publish older code.`);
    }
  }
  await putJson(store, pointerKey(to, runtimeVersion), source);
  return next.id;
}

/** Publishes the code of an old update again, as a new and newer update. */
export async function rollbackUpdate(store: ObjectStore, signer: Signer, channel: Channel, updateId: string, now = new Date()): Promise<Manifest> {
  const previous = await readRelease(store, signer.certificate, updateId);
  const manifest: Manifest = { ...previous, id: randomUUID(), createdAt: now.toISOString() };
  await writeRelease(store, signer, channel, manifest);
  return manifest;
}

/** Tells installed apps to run the bundle that shipped inside the store build. */
export async function rollBackToEmbedded(store: ObjectStore, signer: Signer, channel: Channel, runtimeVersion: string, now = new Date()): Promise<void> {
  const directive = JSON.stringify({ type: 'rollBackToEmbedded', parameters: { commitTime: now.toISOString() } });
  await putJson(store, pointerKey(channel, runtimeVersion), { directive, signature: signer.sign(directive), keyid: 'root' });
}

/** The runtime version that a built .app embeds. This is what the installed app sends. */
export async function embeddedRuntime(appPath: string): Promise<string> {
  const candidates = [join(appPath, 'EXUpdates.bundle/fingerprint')];
  const frameworks = join(appPath, 'Frameworks');
  if (existsSync(frameworks)) {
    for (const name of await readdir(frameworks)) candidates.push(join(frameworks, name, 'EXUpdates.bundle/fingerprint'));
  }
  const matches = candidates.filter(path => existsSync(path));
  if (matches.length !== 1) throw new Error(`Expected exactly one EXUpdates.bundle/fingerprint in ${appPath}, found ${matches.length}`);
  return identifier((await readFile(matches[0]!, 'utf8')).trim());
}

export function parseResolvedRuntime(output: string): string {
  const value = JSON.parse(output) as { runtimeVersion?: unknown };
  return identifier(value.runtimeVersion);
}

function expoEnvironment(channel: Channel): NodeJS.ProcessEnv {
  return { ...process.env, BBQLAW_CHANNEL: channel, CI: '1', EXPO_NO_TELEMETRY: '1', NODE_ENV: 'production', EXPO_UPDATES_WORKFLOW_OVERRIDE: 'managed' };
}
function npx(args: string[], channel: Channel): string {
  return execFileSync('npx', ['--no-install', ...args], {
    cwd: APP_DIRECTORY, env: expoEnvironment(channel), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
}

async function resolveRuntime(channel: Channel, appPath: string | undefined): Promise<string> {
  if (appPath) return embeddedRuntime(resolve(appPath));
  return parseResolvedRuntime(npx(['expo-updates', 'runtimeversion:resolve', '--platform', 'ios'], channel));
}

export function wranglerStore(directory: string, wrangler = WRANGLER): ObjectStore {
  const run = (args: string[]) => execFileSync(wrangler, ['r2', 'object', ...args, '--remote'], {
    cwd: resolve(APP_DIRECTORY, '../updates-worker'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    async get(key) {
      const file = join(directory, randomUUID());
      try {
        run(['get', `${BUCKET}/${key}`, '--file', file]);
      } catch (error) {
        const output = `${(error as { stdout?: string }).stdout ?? ''}${(error as { stderr?: string }).stderr ?? ''}`;
        // Only a missing key means "no object". Auth and network errors must stop.
        if (output.includes('The specified key does not exist')) return null;
        throw new Error(`wrangler r2 object get failed for ${key}:\n${output}`);
      }
      return readFile(file);
    },
    async put(key, bytes, contentType) {
      const file = join(directory, randomUUID());
      await writeFile(file, bytes);
      run(['put', `${BUCKET}/${key}`, '--file', file, '--content-type', contentType]);
    },
  };
}

const USAGE = `Commands:
  publish  --channel preview|production [--app <built .app>]
  promote  --from preview --to production [--app <preview .app>] [--to-app <production .app>]
  rollback --channel preview|production --to <updateId>
  embedded --channel preview|production [--app <built .app>]`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { channel: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, app: { type: 'string' }, 'to-app': { type: 'string' } },
  });
  if (!['publish', 'promote', 'rollback', 'embedded'].includes(command ?? '')) throw new Error(USAGE);
  const certificate = await readFile(DEFAULT_CERTIFICATE_PATH);
  const signer = async () => loadSigner(await readFile(DEFAULT_KEY_PATH, 'utf8'), certificate);
  const directory = await mkdtemp(join(tmpdir(), 'bbqlaw-ota-'));
  try {
    const store = wranglerStore(directory);
    if (command === 'publish') {
      const channel = channelName(values.channel);
      // Resolve the runtime and check the key before the slow export and any upload.
      const runtimeVersion = await resolveRuntime(channel, values.app);
      const key = await signer();
      const configuration = JSON.parse(npx(['expo', 'config', '--type', 'public', '--json'], channel)) as Record<string, unknown>;
      delete configuration._internal;
      const exportDirectory = join(directory, 'export');
      process.stdout.write(npx(['expo', 'export', '--platform', 'ios', '--output-dir', exportDirectory], channel));
      const manifest = await publishUpdate(store, key, channel, {
        exportDirectory, configuration, runtimeVersion, id: randomUUID(), createdAt: new Date().toISOString(),
      });
      process.stdout.write(`Published ${manifest.id} to ${channel} (runtime ${runtimeVersion})\n`);
    } else if (command === 'promote') {
      const from = channelName(values.from);
      const to = channelName(values.to);
      const id = await promoteUpdate(store, certificate, {
        from, to,
        runtimeVersion: await resolveRuntime(from, values.app),
        targetRuntimeVersion: await resolveRuntime(to, values['to-app']),
      });
      process.stdout.write(`Promoted ${id} from ${from} to ${to}\n`);
    } else if (command === 'rollback') {
      const channel = channelName(values.channel);
      const manifest = await rollbackUpdate(store, await signer(), channel, identifier(values.to));
      process.stdout.write(`Published ${manifest.id} (copy of ${values.to}) to ${channel} (runtime ${manifest.runtimeVersion})\n`);
    } else {
      const channel = channelName(values.channel);
      const runtimeVersion = await resolveRuntime(channel, values.app);
      await rollBackToEmbedded(store, await signer(), channel, runtimeVersion);
      process.stdout.write(`${channel} now rolls back to the embedded bundle (runtime ${runtimeVersion})\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
