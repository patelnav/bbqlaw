// The stored format matches the 1.0 app's.
export interface Credentials {
  deviceId: string;
  deviceToken: string;
  ingestURL: string;
  readerToken?: string;
}

export function parseCredentials(text: string | null): Credentials | null {
  if (text === null) return null;
  let data: Partial<Credentials> | null;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const { deviceId, deviceToken, ingestURL, readerToken } = data ?? {};
  if (typeof deviceId !== 'string' || typeof deviceToken !== 'string' || typeof ingestURL !== 'string') return null;
  if (!ingestURL.startsWith('https://')) return null;
  return {
    deviceId,
    deviceToken,
    ingestURL,
    ...(typeof readerToken === 'string' ? { readerToken } : {}),
  };
}

export interface CredentialStore {
  load(): Promise<Credentials | null>;
  save(credentials: Credentials): Promise<boolean>;
  clear(): Promise<void>;
}
