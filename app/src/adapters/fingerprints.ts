// Known GATT fingerprint hashes (spec §6.3): the hash of a layout that we know an
// adapter reads. It only changes the trial order. Add an entry when a capture
// from real hardware confirms it. Public sources give no complete layouts, so
// the table starts empty.
export const FINGERPRINTS: Readonly<Record<string, string>> = {};
