import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { UploadInput } from './types';

/** Bytes + display name of an upload input. */
export interface LoadedArtifact {
  bytes: Uint8Array;
  fileName: string;
}

/** Read an upload input from disk (or take its bytes) and resolve its file name. */
export async function loadArtifact(input: UploadInput): Promise<LoadedArtifact> {
  if (input.artifactPath !== undefined) {
    const bytes = await readFile(input.artifactPath);
    return { bytes, fileName: input.fileName ?? basename(input.artifactPath) };
  }
  return { bytes: input.bytes, fileName: input.fileName ?? `artifact.${input.kind}` };
}
