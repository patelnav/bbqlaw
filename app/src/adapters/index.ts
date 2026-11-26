// Adapter registry. To add a thermometer: one adapter file + its vectors.
import type { AdapterDef } from '../engine/types';
import { adapter as ibbq } from './ibbq-fff0';
import { adapter as inkbirdInt11iB } from './inkbird-int-11i-b';
import { adapter as thermopro } from './thermopro-fff0';
import ibbqVectors from './vectors/ibbq-fff0.json';
import inkbirdVectors from './vectors/inkbird-int-11i-b.json';
import thermoproVectors from './vectors/thermopro-fff0.json';

export const ADAPTERS: readonly AdapterDef[] = [inkbirdInt11iB, ibbq, thermopro];

export const VECTORS: Record<string, unknown[]> = {
  'inkbird-int-11i-b': inkbirdVectors,
  'ibbq-fff0': ibbqVectors,
  'thermopro-fff0': thermoproVectors,
};

export const adapterById = (id: string | null | undefined): AdapterDef | null =>
  ADAPTERS.find((a) => a.id === id) ?? null;
