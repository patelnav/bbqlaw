import { isHex } from './uuid';

export const toHex = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): number[] {
  if (hex.length % 2 !== 0 || !isHex(hex)) throw new Error(`bad hex "${hex}"`);
  return Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}
