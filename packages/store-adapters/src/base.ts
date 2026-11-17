import { UnsupportedCapabilityError } from './errors';
import type {
  Capability,
  ListingUpdate,
  ReviewStatus,
  SetTrackInput,
  StoreAdapter,
  StoreId,
  TrackState,
  UploadInput,
  UploadResult,
} from './types';

/** Base class: every operation rejects with `UnsupportedCapabilityError` unless overridden. */
export abstract class BaseStoreAdapter implements StoreAdapter {
  abstract readonly id: StoreId;
  abstract readonly capabilities: ReadonlySet<Capability>;

  /** True when the adapter advertises `capability`. */
  supports(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  protected unsupported(capability: Capability, detail?: string): never {
    throw new UnsupportedCapabilityError(this.id, capability, detail);
  }

  async upload(_input: UploadInput): Promise<UploadResult> {
    return this.unsupported('upload');
  }
  async setTrack(_input: SetTrackInput): Promise<TrackState> {
    return this.unsupported('tracks');
  }
  async getTrack(_track: string): Promise<TrackState> {
    return this.unsupported('tracks');
  }
  async halt(_track: string): Promise<TrackState> {
    return this.unsupported('halt');
  }
  async resume(_track: string, _userFraction?: number): Promise<TrackState> {
    return this.unsupported('resume');
  }
  async complete(_track: string): Promise<TrackState> {
    return this.unsupported('complete');
  }
  async getReviewStatus(): Promise<ReviewStatus> {
    return this.unsupported('review_status');
  }
  async updateListing(_locale: string, _listing: ListingUpdate): Promise<void> {
    return this.unsupported('listing');
  }
}
