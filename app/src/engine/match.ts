// adapter-engine.md §5: match rules and ranking.
import type { AdapterDef, MatchRule } from './types';
import { canonicalUUID } from './uuid';

export interface Advertisement {
  name: string | null;
  services: string[];
  manufacturerData: string | null;
}

/** Company id = first two bytes of the manufacturer data, little-endian. */
export function manufacturerIdOf(hex: string | null): number | null {
  if (hex === null || hex.length < 4) return null;
  const id = parseInt(hex.slice(2, 4) + hex.slice(0, 2), 16);
  return Number.isNaN(id) ? null : id;
}

function ruleMatches(rule: MatchRule, ad: Advertisement): boolean {
  if (rule.namePrefix === undefined && rule.service === undefined && rule.manufacturerId === undefined) {
    return false;
  }
  if (rule.namePrefix !== undefined) {
    if (ad.name === null || !ad.name.toLowerCase().startsWith(rule.namePrefix.toLowerCase())) return false;
  }
  if (rule.service !== undefined) {
    const wanted = canonicalUUID(rule.service);
    if (wanted === null || !ad.services.some((s) => canonicalUUID(s) === wanted)) return false;
  }
  if (rule.manufacturerId !== undefined && manufacturerIdOf(ad.manufacturerData) !== rule.manufacturerId) {
    return false;
  }
  return true;
}

const fieldCount = (r: MatchRule) =>
  [r.namePrefix, r.service, r.manufacturerId].filter((v) => v !== undefined).length;

/** Most fields wins; then the longest namePrefix; then id alphabetical. */
export function matchAdapter(adapters: readonly AdapterDef[], ad: Advertisement): AdapterDef | null {
  const hits: { def: AdapterDef; fields: number; prefix: number }[] = [];
  for (const def of adapters) {
    for (const rule of def.match) {
      if (!ruleMatches(rule, ad)) continue;
      hits.push({ def, fields: fieldCount(rule), prefix: rule.namePrefix?.length ?? 0 });
    }
  }
  hits.sort((a, b) => b.fields - a.fields || b.prefix - a.prefix || (a.def.id < b.def.id ? -1 : a.def.id > b.def.id ? 1 : 0));
  return hits[0]?.def ?? null;
}
