import type { Capability, StoreId } from './types';

/** Thrown when an adapter is asked for a capability it does not have. */
export class UnsupportedCapabilityError extends Error {
  override readonly name = 'UnsupportedCapabilityError';
  constructor(
    readonly storeId: StoreId,
    readonly capability: Capability,
    detail?: string,
  ) {
    super(`${storeId} does not support '${capability}'${detail ? `: ${detail}` : ''}`);
  }
}

/** Thrown before any network call when the input breaks a store rule. */
export class StoreValidationError extends Error {
  override readonly name = 'StoreValidationError';
}

/** Thrown when the store is not in a state that allows the operation. */
export class StoreStateError extends Error {
  override readonly name = 'StoreStateError';
}

/** Thrown on a non-2xx store response. The URL is logged without its query (SAS tokens). */
export class StoreApiError extends Error {
  override readonly name = 'StoreApiError';
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${method} ${url.replace(/\?.*$/, '')} -> HTTP ${status}: ${body.slice(0, 500)}`);
  }
}
