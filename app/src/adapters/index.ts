// Adapter registry. To add a thermometer: one adapter file + its vectors.
import type { AdapterDef } from '../engine/types';
import { adapter as inkbirdInt11iB } from './inkbird-int-11i-b';
import inkbirdVectors from './vectors/inkbird-int-11i-b.json';

export const ADAPTERS: readonly AdapterDef[] = [inkbirdInt11iB];

export const VECTORS: Record<string, unknown[]> = {
  'inkbird-int-11i-b': inkbirdVectors,
};

export const adapterById = (id: string | null | undefined): AdapterDef | null =>
  ADAPTERS.find((a) => a.id === id) ?? null;
