// INKBIRD INT-11I-B.
//   FF01  temperature (notify): LE16 °F x 100
//   FF02  auth + control (write / notify): concatenated <LEN><TYPE><body> frames
//   2A19  battery: [base %, probe %]
//
// The device sends the auth challenge only after every FF00-family notify
// characteristic is subscribed. The engine does that before onReady().

var CONTROL = "FF02";
var MAX_ATTEMPTS = 5;
var RETRY_MS = 2500;
var TARGET_SCALE = 100; // °F multiplier in device target frames
var BUZZER_VOLUME = 2;  // 1 = low ... 3 = high

var attempts = 0;
var challengeSeen = false;
var authState = "none"; // none | requested | waiting | authed | failed

// Non-reflected (MSB-first) CRC-8.
function crc8(bytes, poly, initial) {
  var crc = initial;
  for (var i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? (((crc << 1) ^ poly) & 0xff) : ((crc << 1) & 0xff);
    }
  }
  return crc;
}

// Verify packet `08 fc <ms%1000 LE16><epoch_s LE32><CRC>`.
function authResponse(challenge) {
  var millis = Math.floor(host.nowMs());
  var epoch = Math.floor(millis / 1000) % 4294967296;
  var rem = millis % 1000;
  var time6 = [
    rem & 0xff, (rem >>> 8) & 0xff,
    epoch & 0xff, (epoch >>> 8) & 0xff, (epoch >>> 16) & 0xff, (epoch >>> 24) & 0xff
  ];
  var inner = crc8(time6, 0xd5, 0x00);   // CRC-8/DVB-S2
  var cdma = crc8(challenge, 0x9b, 0xff); // CRC-8/CDMA2000
  var check = crc8(time6.concat([inner, cdma]), 0xd5, 0x00);
  return [0x08, 0xfc].concat(time6, [check]);
}

function startAuth() {
  attempts += 1;
  var attempt = attempts;
  authState = "requested";
  host.status("authenticating");
  host.log("auth: -> 01 fb (attempt " + attempt + ")");
  host.write(CONTROL, [0x01, 0xfb]);
  host.after(RETRY_MS, function () {
    if (challengeSeen || authState !== "requested" || attempt !== attempts) return;
    if (attempt < MAX_ATTEMPTS) {
      startAuth();
    } else {
      host.log("auth: no challenge, waiting for probe");
      authState = "waiting";
      host.status("waiting");
    }
  });
}

function parseFrames(bytes) {
  var frames = [];
  var i = 0;
  while (i < bytes.length) {
    var length = bytes[i];
    if (length === 0 || i + 1 + length > bytes.length) break;
    frames.push({ type: bytes[i + 1], body: bytes.slice(i + 2, i + 1 + length) });
    i += 1 + length;
  }
  return frames;
}

function handleControl(bytes) {
  var authed = authState === "authed"; // as of the start of this notification
  parseFrames(bytes).forEach(function (f) {
    if (f.type === 0xfb && f.body.length >= 6 && !challengeSeen && !authed) {
      challengeSeen = true;
      host.log("auth: <- challenge; -> verify");
      host.write(CONTROL, authResponse(f.body.slice(0, 6)));
    } else if (f.type === 0xfc && !authed) {
      if (f.body[0] === 0) {
        authState = "authed";
        host.status("ready");
      } else {
        authState = "failed";
        var code = f.body.length > 0 ? f.body[0] : 0xff;
        host.status("failed", "auth rejected (status " + code + ")");
      }
    }
  });
}

function handleTemperature(bytes) {
  if (bytes.length < 2) {
    host.reading(0, { state: "none" });
    return;
  }
  var raw = bytes[0] | (bytes[1] << 8);
  if (raw === 0x7ffe || raw === 0x7fff || raw === 0x8000) {
    host.reading(0, { state: "docked" }); // error / no probe / docked or off
  } else if (raw === 0x0000 || raw === 0xffff) {
    host.reading(0, { state: "none" });
  } else {
    host.reading(0, { state: "live", foodF: raw / 100 });
  }
}

// A single byte is the base level (byte-0 ordering).
function handleBattery(bytes) {
  host.battery({
    base: bytes.length > 0 ? bytes[0] : null,
    probe: bytes.length > 1 ? bytes[1] : null
  });
}

function frame(type, body) {
  return [1 + body.length, type].concat(body);
}

var adapter = {
  onReady: function () {
    startAuth();
  },

  onNotify: function (char, bytes) {
    if (char === "FF01") handleTemperature(bytes);
    else if (char === "FF02") handleControl(bytes);
    else if (char === "2A19") handleBattery(bytes);
  },

  setTarget: function (channel, highF) {
    var body1;
    var body2 = [0x01, 0x00, 0x00, 0x00, 0x00];
    if (highF === null) {
      body1 = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    } else {
      var scaled = Math.min(65535, Math.max(0, Math.trunc(highF * TARGET_SCALE)));
      body1 = [0x01, 0x10, scaled & 0xff, scaled >> 8, 0x00, 0x00, 0x0a, 0x1b];
    }
    host.write(CONTROL, frame(0x01, body1).concat(frame(0x23, body2)));
  },

  setBuzzer: function (channel, muted) {
    host.write(CONTROL, muted ? [0x03, 0x0b, 0x11, 0x01] : [0x03, 0x0b, 0x5a, BUZZER_VOLUME]);
  }
};
