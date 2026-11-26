// ThermoPro TP25 family (service 1086fff0-…). NOT verified on hardware by us.
//
// Every byte here comes from these public implementations. Nothing is guessed.
//   [1] coxtor/thermopro-tp25, custom_components/thermopro/_tp25_protocol.py and coordinator.py
//       https://github.com/coxtor/thermopro-tp25/tree/047067808f83
//       Apache-2.0. Its packet notes also credit martin-hughes/thermopro-tools
//       (MIT, Copyright 2025 Martin Hughes).
//   [2] kwood1992/thermopro-tp25-ble, client.py and constants.py
//       https://github.com/kwood1992/thermopro-tp25-ble/tree/5003c331e6ac  (Apache-2.0)
//   [3] petrkr/thermopro-tp902, PROTOCOL.md and tp902/__init__.py
//       https://github.com/petrkr/thermopro-tp902/tree/1deac03743e1  (MIT)
//
//   Frame: CMD LEN DATA[LEN] CHECKSUM, checksum = sum of the bytes before it
//          mod 256; later bytes are padding [1][3].
//   1086fff1  write, with response (the only write type it has) [1]
//     01 09 8a 7a 13 b7 3e d6 8b 67 c2 a0   start frame [1][2]
//     30 00 30   ask for temperatures; also acknowledges a report. [1] sends it
//                after each report and every 10 s.
//   1086fff2  notify
//     01 01 0a   start frame accepted [1]
//     30 LEN battery unit alarms, then 2 bytes per probe [1][3]
//   Temperature: BCD tenths of °C; top bit = negative; ffff = no probe;
//   dddd / eeee = special states [1][3]. Values stay °C when the display shows °F [1].
import type { AdapterDef, AdapterHost } from '../engine/types';

const SERVICE = '1086FFF0-3343-4817-8BB2-B32206336CE8';
const WRITE = '1086FFF1-3343-4817-8BB2-B32206336CE8';
const NOTIFY = '1086FFF2-3343-4817-8BB2-B32206336CE8';
const START_FRAME = [0x01, 0x09, 0x8a, 0x7a, 0x13, 0xb7, 0x3e, 0xd6, 0x8b, 0x67, 0xc2, 0xa0];
const READ_TEMPERATURES = [0x30, 0x00, 0x30];
const TEMPERATURE_REPORT = 0x30;
const START_REPLY = 0x01;
const START_ACCEPTED = 0x0a;
const REQUEST_EVERY_MS = 10_000;
const MIN_REQUEST_GAP_MS = 1000; // our limit: a reply to a request must not cause a request loop
const PROBES = 4;
const REPORT_LENGTHS = [11, 15]; // 4 probes, or 4 plus two more slots [1]

const celsiusToFahrenheit = (c: number) => (c * 9) / 5 + 32;

function parseFrame(bytes: number[]): { command: number; data: number[] } | null {
  if (bytes.length < 3) return null;
  const end = bytes[1]! + 2;
  if (bytes.length <= end) return null;
  const sum = bytes.slice(0, end).reduce((total, b) => total + b, 0) & 0xff;
  return sum === bytes[end] ? { command: bytes[0]!, data: bytes.slice(2, end) } : null;
}

/** °C, `null` for no probe or a special state, `undefined` for bad digits. */
function temperature(high: number, low: number): number | null | undefined {
  const special = high === low && (high === 0xff || high === 0xdd || high === 0xee);
  if (special) return null;
  const digits = [(high >> 4) & 0x7, high & 0xf, low >> 4, low & 0xf];
  if (digits.some((d) => d > 9)) return undefined;
  const tenths = digits[0]! * 1000 + digits[1]! * 100 + digits[2]! * 10 + digits[3]!;
  return (high & 0x80 ? -tenths : tenths) / 10;
}

function create(host: AdapterHost) {
  let ready = false;
  let polling = false;
  let lastRequestAt = 0;

  function request() {
    lastRequestAt = host.nowMs();
    host.writeWithResponse(WRITE, READ_TEMPERATURES);
  }

  function poll() {
    host.after(REQUEST_EVERY_MS, () => {
      request();
      poll();
    });
  }

  function handleReport(data: number[]) {
    if (!REPORT_LENGTHS.includes(data.length)) return;
    const values: (number | null)[] = [];
    for (let probe = 0; probe < PROBES; probe++) {
      const value = temperature(data[3 + probe * 2]!, data[4 + probe * 2]!);
      if (value === undefined) return; // a bad frame gives no readings at all [1]
      values.push(value);
    }
    if (!ready) {
      ready = true;
      host.status('ready');
    }
    values.forEach((celsius, channel) => {
      if (celsius === null) host.reading(channel, { state: 'none' });
      else host.reading(channel, { state: 'live', foodF: celsiusToFahrenheit(celsius) });
    });
    if (host.nowMs() - lastRequestAt >= MIN_REQUEST_GAP_MS) request(); // acknowledge
  }

  return {
    onReady() {
      host.status('authenticating');
      host.writeWithResponse(WRITE, START_FRAME);
    },
    onNotify(char: string, bytes: number[]) {
      if (char !== NOTIFY) return;
      const frame = parseFrame(bytes);
      if (!frame) return;
      if (frame.command === START_REPLY) {
        if (frame.data.length !== 1 || frame.data[0] !== START_ACCEPTED) {
          host.status('failed', 'start frame rejected');
        } else if (!polling) {
          polling = true;
          request();
          poll();
        }
      } else if (frame.command === TEMPERATURE_REPORT) {
        handleReport(frame.data);
      }
    },
  };
}

export const adapter: AdapterDef = {
  id: 'thermopro-fff0',
  name: 'ThermoPro TP25',
  family: 'thermopro-fff0',
  verified: false,
  match: [], // never matched from an advertisement: only identify assigns it
  signature: { service: SERVICE, chars: [WRITE, NOTIFY] },
  trialSafe: true,
  gatt: { notify: [NOTIFY], read: [], write: [WRITE] },
  channels: PROBES,
  capabilities: ['food'],
  create,
};
