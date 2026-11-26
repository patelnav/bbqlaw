// iBBQ family (Inkbird IBT series, EasyBBQ and others). NOT verified on hardware.
//
// Every byte here comes from these public implementations. Nothing is guessed.
//   [1] adafruit/Adafruit_CircuitPython_BLE_iBBQ, adafruit_ble_ibbq.py
//       https://github.com/adafruit/Adafruit_CircuitPython_BLE_iBBQ/blob/a598ffd835ec/adafruit_ble_ibbq.py
//       MIT, Copyright 2020 Dan Halbert for Adafruit Industries
//   [2] sworisbreathing/go-ibbq, const.go and ibbq.go
//       https://github.com/sworisbreathing/go-ibbq/tree/2891c9740049
//       Apache-2.0, Copyright 2018 the original author or authors
//   [3] gleeds/cloudbbq, app.js
//       https://github.com/gleeds/cloudbbq  (MIT)
//
//   FFF2  write: login ("account and verify") message [1][2]
//   FFF5  write: settings; 0b 01 00 00 00 00 starts real-time data [1][2]
//   FFF4  notify: one LE16 per probe, °C x 10, whatever the display unit [1][2]
//         No probe: raw -10 [3]; 0.0 [1]
//   Writes use "with response" [1][2].
import type { AdapterDef, AdapterHost } from '../engine/types';

const LOGIN = 'FFF2';
const SETTINGS = 'FFF5';
const REALTIME = 'FFF4';
const LOGIN_MESSAGE = [0x21, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0xb8, 0x22, 0x00, 0x00, 0x00, 0x00, 0x00];
const START_REALTIME = [0x0b, 0x01, 0x00, 0x00, 0x00, 0x00];
const NO_PROBE = -10;
const CHANNELS = 8;

const celsiusToFahrenheit = (c: number) => (c * 9) / 5 + 32;

function create(host: AdapterHost) {
  let ready = false;
  return {
    onReady() {
      host.status('authenticating');
      host.writeWithResponse(LOGIN, LOGIN_MESSAGE);
      host.writeWithResponse(SETTINGS, START_REALTIME);
    },
    onNotify(char: string, bytes: number[]) {
      if (char !== REALTIME) return;
      if (bytes.length < 2 || bytes.length % 2 !== 0 || bytes.length > CHANNELS * 2) return;
      if (!ready) {
        ready = true;
        host.status('ready');
      }
      for (let channel = 0; channel < bytes.length / 2; channel++) {
        const unsigned = bytes[channel * 2]! | (bytes[channel * 2 + 1]! << 8);
        const raw = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
        if (raw === NO_PROBE || raw === 0) host.reading(channel, { state: 'none' });
        else host.reading(channel, { state: 'live', foodF: celsiusToFahrenheit(raw / 10) });
      }
    },
  };
}

export const adapter: AdapterDef = {
  id: 'ibbq-fff0',
  name: 'iBBQ',
  family: 'ibbq-fff0',
  verified: false,
  match: [], // never matched from an advertisement: only identify assigns it
  signature: { service: 'FFF0', chars: ['FFF2', 'FFF4', 'FFF5'] },
  trialSafe: true,
  gatt: { notify: [REALTIME], read: [], write: [LOGIN, SETTINGS] },
  channels: CHANNELS,
  capabilities: ['food'],
  create,
};
