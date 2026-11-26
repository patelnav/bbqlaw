#!/usr/bin/env node
// Validate every adapter, run its golden vectors, and write the generated files.
//   node adapters/tools/build.mjs          write catalog.json + test-vectors.json
//   node adapters/tools/build.mjs --check  exit 1 on a stale file or a failing vector
// No dependencies. The host checks and gate mirror BBQlaw/AdapterRuntime.swift.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ENGINE = 1;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEX = "0123456789abcdefABCDEF";
const BASE_SUFFIX = "-0000-1000-8000-00805F9B34FB";
const STATUSES = ["authenticating", "waiting", "ready", "failed"];
const READING_STATES = ["live", "docked", "none"];

// ---------- UUIDs ----------

const isHex = (s) => [...s].every((c) => HEX.includes(c));

/** Canonical UUID string, or null when invalid. */
function canonicalUUID(value) {
  if (typeof value !== "string") return null;
  if (value.length === 4) return isHex(value) ? value.toUpperCase() : null;
  if (value.length !== 36) return null;
  for (let i = 0; i < 36; i++) {
    const hyphen = i === 8 || i === 13 || i === 18 || i === 23;
    if (hyphen ? value[i] !== "-" : !HEX.includes(value[i])) return null;
  }
  const upper = value.toUpperCase();
  return upper.startsWith("0000") && upper.endsWith(BASE_SUFFIX) ? upper.slice(4, 8) : upper;
}

// ---------- Manifest ----------

function isKebab(id) {
  const allowed = "abcdefghijklmnopqrstuvwxyz0123456789-";
  return typeof id === "string" && id.length > 0 && [...id].every((c) => allowed.includes(c))
    && !id.startsWith("-") && !id.endsWith("-") && !id.includes("--");
}

function validateManifest(m, folder) {
  const errors = [];
  const need = (ok, message) => { if (!ok) errors.push(message); };
  need(isKebab(m.id), "id must be lowercase kebab-case");
  need(m.id === folder, "id must equal the folder name");
  need(Number.isInteger(m.version), "version must be an integer");
  need(Number.isInteger(m.engine) && m.engine >= 1 && m.engine <= ENGINE, `engine must be 1..${ENGINE}`);
  need(typeof m.name === "string" && m.name.length > 0, "name is required");
  need(Number.isInteger(m.channels) && m.channels >= 1 && m.channels <= 8, "channels must be 1..8");
  need(Array.isArray(m.capabilities) && m.capabilities.every((c) => typeof c === "string")
    && m.capabilities.includes("food"), "capabilities must be strings and include food");
  need(Array.isArray(m.match) && m.match.length > 0, "match must be a non-empty array");
  for (const rule of Array.isArray(m.match) ? m.match : []) {
    const fields = ["namePrefix", "service", "manufacturerId"].filter((k) => rule[k] !== undefined);
    need(fields.length > 0, "every match rule needs a field");
    need(Object.keys(rule).length === fields.length, "unknown field in a match rule");
    if (rule.namePrefix !== undefined) need(typeof rule.namePrefix === "string" && rule.namePrefix.length > 0, "bad namePrefix");
    if (rule.service !== undefined) need(canonicalUUID(rule.service) !== null, `bad service UUID ${rule.service}`);
    if (rule.manufacturerId !== undefined) {
      need(Number.isInteger(rule.manufacturerId) && rule.manufacturerId >= 0 && rule.manufacturerId <= 0xffff, "bad manufacturerId");
    }
  }
  for (const key of ["notify", "read", "write"]) {
    const list = m.gatt?.[key];
    need(Array.isArray(list), `gatt.${key} must be an array`);
    for (const uuid of Array.isArray(list) ? list : []) need(canonicalUUID(uuid) !== null, `bad UUID in gatt.${key}: ${uuid}`);
  }
  if (m.disabled !== undefined) need(typeof m.disabled === "boolean", "disabled must be a boolean");
  if (m.notes !== undefined) need(typeof m.notes === "string", "notes must be a string");
  return errors;
}

// ---------- Runtime ----------

const toHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !isHex(hex)) throw new Error(`bad hex "${hex}"`);
  return Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function readBytes(value) {
  if (!Array.isArray(value) && !(ArrayBuffer.isView(value) && typeof value.length === "number")) return null;
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const b = value[i];
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) return null;
    out.push(b);
  }
  return out;
}

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const clampPercent = (v) => Math.min(100, Math.max(0, v));

/** One adapter instance with the real host checks and the setTarget/setBuzzer gate. */
function makeRuntime(manifest, script, startMs) {
  const writable = new Set(manifest.gatt.write.map(canonicalUUID));
  const deviceAlarm = manifest.capabilities.includes("deviceAlarm");
  const record = { writes: [], readings: [], battery: [], status: [], dropped: [] };
  const timers = [];
  let elapsed = 0;
  let sequence = 0;
  let status = "subscribing";

  const drop = (why) => { record.dropped.push(why); };
  const validChannel = (c) => Number.isInteger(c) && c >= 0 && c < manifest.channels;

  /** Copy the keys the adapter passed; null stays null. Returns null on a bad value. */
  function numbers(source, keys, into, transform = (v) => v) {
    for (const key of keys) {
      const v = source[key];
      if (v === undefined) continue;
      if (v !== null && !isFiniteNumber(v)) return null;
      into[key] = v === null ? null : transform(v);
    }
    return into;
  }

  function write(char, bytes, withResponse) {
    const uuid = canonicalUUID(char);
    if (uuid === null || !writable.has(uuid)) return drop(`write to ${char} is not allowed`);
    const data = readBytes(bytes);
    if (data === null) return drop("write: bad bytes");
    record.writes.push({ char: uuid, hex: toHex(data), withResponse });
  }

  const host = {
    write: (char, bytes) => write(char, bytes, false),
    writeWithResponse: (char, bytes) => write(char, bytes, true),
    reading(channel, r) {
      if (!validChannel(channel)) return drop("reading: bad channel");
      if (typeof r !== "object" || r === null || !READING_STATES.includes(r.state)) return drop("reading: bad state");
      const out = numbers(r, ["foodF", "ambientF"], { channel, state: r.state });
      if (out === null) return drop("reading: bad number");
      if (r.state === "live" && !isFiniteNumber(out.foodF)) return drop("reading: live needs foodF");
      record.readings.push(out);
    },
    battery(b) {
      if (typeof b !== "object" || b === null) return drop("battery: not an object");
      const out = numbers(b, ["base", "probe"], {}, clampPercent);
      if (out === null) return drop("battery: bad number");
      if (b.channel !== undefined && b.channel !== null) {
        if (!validChannel(b.channel)) return drop("battery: bad channel");
        out.channel = b.channel;
      }
      record.battery.push(out);
    },
    status(s) {
      if (!STATUSES.includes(s)) return drop(`status: unknown ${s}`);
      status = s;
      record.status.push(s);
    },
    after(ms, fn) {
      if (!isFiniteNumber(ms) || typeof fn !== "function") return drop("after: bad arguments");
      timers.push({ due: elapsed + Math.max(0, ms), sequence: sequence++, fn });
    },
    nowMs: () => startMs + elapsed,
    log: () => {},
  };

  const context = vm.createContext({ host });
  vm.runInContext(script, context, { timeout: 1000 });
  const adapter = vm.runInContext("typeof adapter === 'object' ? adapter : undefined", context);
  const required = ["onReady", "onNotify", ...(deviceAlarm ? ["setTarget", "setBuzzer"] : [])];
  for (const name of required) {
    if (typeof adapter?.[name] !== "function") throw new Error(`adapter.${name} must be a function`);
  }

  function advance(ms) {
    const target = elapsed + ms;
    for (let fired = 0; ; fired++) {
      if (fired > 10000) throw new Error("advance: too many timers");
      timers.sort((a, b) => a.due - b.due || a.sequence - b.sequence);
      if (timers.length === 0 || timers[0].due > target) break;
      const timer = timers.shift();
      elapsed = timer.due;
      timer.fn();
    }
    elapsed = target;
  }

  const gateOpen = () => status === "ready" && deviceAlarm;

  return {
    record,
    step(s) {
      if (s.ready) adapter.onReady();
      else if (s.notify) {
        const char = canonicalUUID(s.notify.char);
        if (char === null) throw new Error(`bad notify UUID ${s.notify.char}`);
        adapter.onNotify(char, fromHex(s.notify.hex));
      } else if (s.setTarget) {
        if (gateOpen()) adapter.setTarget(s.setTarget.channel, s.setTarget.highF);
      } else if (s.setBuzzer) {
        if (gateOpen()) adapter.setBuzzer(s.setBuzzer.channel, s.setBuzzer.muted);
      } else if (isFiniteNumber(s.advance)) advance(s.advance);
      else throw new Error(`unknown step ${JSON.stringify(s)}`);
    },
  };
}

function matches(actual, expected) {
  if (typeof expected === "number") return typeof actual === "number" && Math.abs(actual - expected) <= 0.001;
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (actual === null || typeof actual !== "object" || Array.isArray(actual) !== Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length
    && keys.every((k) => k in actual && matches(actual[k], expected[k]));
}

function runCase(manifest, script, testCase) {
  const runtime = makeRuntime(manifest, script, testCase.nowMs ?? 0);
  for (const step of testCase.steps) runtime.step(step);
  const failures = [];
  for (const key of ["writes", "readings", "battery", "status"]) {
    if (!(key in testCase.expect)) continue;
    let expected = testCase.expect[key];
    if (key === "writes") {
      expected = expected.map((w) => ({ char: canonicalUUID(w.char), hex: w.hex, withResponse: w.withResponse ?? false }));
    }
    if (!matches(runtime.record[key], expected)) {
      failures.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(runtime.record[key])}`);
    }
  }
  return failures;
}

// ---------- Build ----------

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

const serialize = (value) => JSON.stringify(sortKeys(value), null, 2) + "\n";
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));

const check = process.argv.includes("--check");
const folders = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "manifest.json")))
  .map((e) => e.name)
  .sort();

const adapters = [];
const vectors = {};
let problems = 0;
let total = 0;
let passed = 0;
const fail = (message) => { console.error(`FAIL ${message}`); problems++; };

for (const folder of folders) {
  try {
    const manifest = readJSON(join(root, folder, "manifest.json"));
    const errors = validateManifest(manifest, folder);
    if (errors.length > 0) { errors.forEach((e) => fail(`${folder}: ${e}`)); continue; }
    const script = readFileSync(join(root, folder, "adapter.js"), "utf8");
    makeRuntime(manifest, script, 0);
    const cases = readJSON(join(root, folder, "vectors.json"));
    if (!Array.isArray(cases) || cases.length === 0) { fail(`${folder}: vectors.json has no cases`); continue; }
    for (const testCase of cases) {
      total++;
      try {
        const failures = runCase(manifest, script, testCase);
        if (failures.length === 0) passed++;
        else failures.forEach((f) => fail(`${folder} "${testCase.name}": ${f}`));
      } catch (error) {
        fail(`${folder} "${testCase.name}": ${error.message}`);
      }
    }
    adapters.push({ ...manifest, script });
    vectors[manifest.id] = cases;
  } catch (error) {
    fail(`${folder}: ${error.message}`);
  }
}

console.log(`${passed}/${total} vectors passed in ${folders.length} adapter(s)`);
if (problems > 0) process.exit(1);

const outputs = {
  "catalog.json": serialize({ schema: 1, adapters }),
  "test-vectors.json": serialize(vectors),
};
for (const [name, text] of Object.entries(outputs)) {
  const path = join(root, name);
  if (!check) {
    writeFileSync(path, text);
    console.log(`wrote adapters/${name}`);
  } else if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
    fail(`adapters/${name} is stale. Run: node adapters/tools/build.mjs`);
  }
}
if (problems > 0) process.exit(1);
if (check) console.log("generated files are current");
