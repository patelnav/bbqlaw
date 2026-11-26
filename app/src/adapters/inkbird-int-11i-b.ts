// INKBIRD INT-11I-B.
//   FF01  temperature (notify): LE16 °F x 100
//   FF02  auth + control (write / notify): concatenated <LEN><TYPE><body> frames
//   2A19  battery: [base %, probe %]
//
// The device sends the auth challenge only after every FF00-family notify
// characteristic is subscribed. The engine does that before onReady().
import type { AdapterDef, AdapterHost } from '../engine/types';

const CONTROL = 'FF02';
const MAX_ATTEMPTS = 5;
const RETRY_MS = 2500;
const TARGET_SCALE = 100; // °F multiplier in device target frames
const BUZZER_VOLUME = 2; // 1 = low ... 3 = high

// Non-reflected (MSB-first) CRC-8.
function crc8(bytes: number[], poly: number, initial: number): number {
  let crc = initial;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

// Verify packet `08 fc <ms%1000 LE16><epoch_s LE32><CRC>`.
function authResponse(nowMs: number, challenge: number[]): number[] {
  const millis = Math.floor(nowMs);
  const epoch = Math.floor(millis / 1000) % 4294967296;
  const rem = millis % 1000;
  const time6 = [
    rem & 0xff,
    (rem >>> 8) & 0xff,
    epoch & 0xff,
    (epoch >>> 8) & 0xff,
    (epoch >>> 16) & 0xff,
    (epoch >>> 24) & 0xff,
  ];
  const inner = crc8(time6, 0xd5, 0x00); // CRC-8/DVB-S2
  const cdma = crc8(challenge, 0x9b, 0xff); // CRC-8/CDMA2000
  const check = crc8(time6.concat([inner, cdma]), 0xd5, 0x00);
  return [0x08, 0xfc, ...time6, check];
}

function parseFrames(bytes: number[]): { type: number; body: number[] }[] {
  const frames: { type: number; body: number[] }[] = [];
  let i = 0;
  while (i < bytes.length) {
    const length = bytes[i]!;
    if (length === 0 || i + 1 + length > bytes.length) break;
    frames.push({ type: bytes[i + 1]!, body: bytes.slice(i + 2, i + 1 + length) });
    i += 1 + length;
  }
  return frames;
}

const frame = (type: number, body: number[]): number[] => [1 + body.length, type, ...body];

function create(host: AdapterHost) {
  let attempts = 0;
  let challengeSeen = false;
  let authState: 'none' | 'requested' | 'waiting' | 'authed' | 'failed' = 'none';

  function startAuth() {
    attempts += 1;
    const attempt = attempts;
    authState = 'requested';
    host.status('authenticating');
    host.log(`auth: -> 01 fb (attempt ${attempt})`);
    host.write(CONTROL, [0x01, 0xfb]);
    host.after(RETRY_MS, () => {
      if (challengeSeen || authState !== 'requested' || attempt !== attempts) return;
      if (attempt < MAX_ATTEMPTS) {
        startAuth();
      } else {
        host.log('auth: no challenge, waiting for probe');
        authState = 'waiting';
        host.status('waiting');
      }
    });
  }

  function handleControl(bytes: number[]) {
    const authed = authState === 'authed'; // as of the start of this notification
    for (const f of parseFrames(bytes)) {
      if (f.type === 0xfb && f.body.length >= 6 && !challengeSeen && !authed) {
        challengeSeen = true;
        host.log('auth: <- challenge; -> verify');
        host.write(CONTROL, authResponse(host.nowMs(), f.body.slice(0, 6)));
      } else if (f.type === 0xfc && !authed) {
        if (f.body[0] === 0) {
          authState = 'authed';
          host.status('ready');
        } else {
          authState = 'failed';
          const code = f.body.length > 0 ? f.body[0] : 0xff;
          host.status('failed', `auth rejected (status ${code})`);
        }
      }
    }
  }

  function handleTemperature(bytes: number[]) {
    if (bytes.length < 2) {
      host.reading(0, { state: 'none' });
      return;
    }
    const raw = bytes[0]! | (bytes[1]! << 8);
    if (raw === 0x7ffe || raw === 0x7fff || raw === 0x8000) {
      host.reading(0, { state: 'docked' }); // error / no probe / docked or off
    } else if (raw === 0x0000 || raw === 0xffff) {
      host.reading(0, { state: 'none' });
    } else {
      host.reading(0, { state: 'live', foodF: raw / 100 });
    }
  }

  // A single byte is the base level (byte-0 ordering).
  function handleBattery(bytes: number[]) {
    host.battery({
      base: bytes.length > 0 ? bytes[0]! : null,
      probe: bytes.length > 1 ? bytes[1]! : null,
    });
  }

  return {
    onReady() {
      startAuth();
    },
    onNotify(char: string, bytes: number[]) {
      if (char === 'FF01') handleTemperature(bytes);
      else if (char === 'FF02') handleControl(bytes);
      else if (char === '2A19') handleBattery(bytes);
    },
    setTarget(_channel: number, highF: number | null) {
      let body1: number[];
      const body2 = [0x01, 0x00, 0x00, 0x00, 0x00];
      if (highF === null) {
        body1 = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
      } else {
        const scaled = Math.min(65535, Math.max(0, Math.trunc(highF * TARGET_SCALE)));
        body1 = [0x01, 0x10, scaled & 0xff, scaled >> 8, 0x00, 0x00, 0x0a, 0x1b];
      }
      host.write(CONTROL, frame(0x01, body1).concat(frame(0x23, body2)));
    },
    setBuzzer(_channel: number, muted: boolean) {
      host.write(CONTROL, muted ? [0x03, 0x0b, 0x11, 0x01] : [0x03, 0x0b, 0x5a, BUZZER_VOLUME]);
    },
  };
}

export const adapter: AdapterDef = {
  id: 'inkbird-int-11i-b',
  name: 'INKBIRD INT-11I-B',
  family: 'inkbird-ff00',
  verified: true,
  match: [{ namePrefix: 'INT-11' }, { namePrefix: 'INKBIRD' }],
  signature: { service: 'FF00', chars: ['FF01', 'FF02', 'FF03'] },
  trialSafe: true,
  gatt: {
    notify: ['FF01', 'FF02', 'FF03', 'FF04', 'FF05', 'FF06', '2A19'],
    read: ['2A19'],
    write: ['FF02'],
  },
  channels: 1,
  capabilities: ['food', 'battery', 'docked', 'deviceAlarm'],
  create,
};
