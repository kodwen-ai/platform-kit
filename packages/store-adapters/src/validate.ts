import { StoreValidationError } from './errors';
import type { LocalizedNotes, SetTrackInput } from './types';

/** Length in Unicode code points (what store consoles count). */
export function charLength(text: string): number {
  return [...text].length;
}

/** Enforce the staged-rollout fraction rule: `0 < f < 1` exactly when status is inProgress. */
export function assertRolloutFraction(input: Pick<SetTrackInput, 'status' | 'userFraction'>): void {
  const f = input.userFraction;
  if (input.status === 'inProgress') {
    if (f === undefined || !(f > 0 && f < 1)) {
      throw new StoreValidationError(
        `status inProgress needs userFraction with 0 < f < 1 (got ${String(f)})`,
      );
    }
  } else if (f !== undefined && input.status !== 'halted') {
    throw new StoreValidationError(`userFraction is only allowed with status inProgress or halted`);
  }
}

/** Enforce a per-locale release notes length limit. */
export function assertNotesLength(notes: LocalizedNotes | undefined, max: number): void {
  for (const [locale, text] of Object.entries(notes ?? {})) {
    const n = charLength(text);
    if (n > max)
      throw new StoreValidationError(`release notes for ${locale} are ${n} chars (max ${max})`);
  }
}

/** Enforce a maximum length on an optional field. */
export function assertMaxLength(field: string, value: string | undefined, max: number): void {
  if (value !== undefined && charLength(value) > max) {
    throw new StoreValidationError(`${field} is ${charLength(value)} chars (max ${max})`);
  }
}

/** First note for `preferred` locale, else the first one present. */
export function pickNote(
  notes: LocalizedNotes | undefined,
  preferred = 'en-US',
): string | undefined {
  if (!notes) return undefined;
  return notes[preferred] ?? Object.values(notes)[0];
}
