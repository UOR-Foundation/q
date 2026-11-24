// One identity for everything the agent stores or cites: the kappa label,
// `blake3:<64 hex>`, of a JSON record under JCS and NFC. Computed by uor-addr,
// never here.
import { kappa } from '@uor-foundation/uor-addr';

/** A stored item. Members are strings, integers, booleans, null, arrays or records, so the label is canonical. */
export type Item = { type: string; [member: string]: unknown };

const LABEL = /^blake3:[0-9a-f]{64}$/;

export const isLabel = (value: unknown): value is string => typeof value === 'string' && LABEL.test(value);

export function labelOf(item: Item): string {
  return kappa.jsonAddress(new TextEncoder().encode(JSON.stringify(item)));
}

/** Recompute the label of what was read and compare. A fact for the kernel, not a decision. */
export function matches(item: Item, label: string): boolean {
  try {
    return labelOf(item) === label;
  } catch {
    return false;
  }
}
