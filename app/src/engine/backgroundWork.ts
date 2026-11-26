// Reference-counted wrapper for the native JS-controlled background task.
import type { BleTransport } from './ble';

export const BACKGROUND_WORK_MS = 25_000;

export type HoldBackgroundWork = () => () => void;

export function createBackgroundWork(ble: BleTransport): HoldBackgroundWork {
  let holds = 0;
  return () => {
    holds += 1;
    ble.beginBackgroundWork(BACKGROUND_WORK_MS).catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      if (holds === 0) ble.endBackgroundWork().catch(() => undefined);
    };
  };
}
