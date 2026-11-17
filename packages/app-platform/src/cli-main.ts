import {
  formatConformanceReport,
  runConformance,
  type ConformanceOptions,
  type ConformanceReport,
} from './conformance-suite';
import { SIGNING_ALGS, type SigningAlg } from './keys';

/** IO seams of the CLI (tests inject them). */
export interface CliIo {
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  run?: (o: ConformanceOptions) => Promise<ConformanceReport>;
}

function detectAlg(pem: string, explicit: string | undefined): SigningAlg {
  if (explicit) {
    if (!(SIGNING_ALGS as readonly string[]).includes(explicit))
      throw new Error(`CODAI_PLATFORM_APP_ALG must be one of ${SIGNING_ALGS.join(', ')}`);
    return explicit as SigningAlg;
  }
  return pem.includes(['BEGIN', 'EC', 'PRIVATE', 'KEY'].join(' ')) || pem.length < 400
    ? 'ES256'
    : 'RS256';
}

/** Run the conformance CLI; returns the process exit code (0 all passed, 1 failures, 2 bad config). Never prints key material. */
export async function runConformanceCli(io: CliIo): Promise<number> {
  const e = io.env;
  const missing = [
    'CODAI_PLATFORM_URL',
    'CODAI_PLATFORM_APP_ID',
    'CODAI_PLATFORM_INSTALLATION_ID',
    'CODAI_PLATFORM_AUDIENCE',
  ].filter((k) => !e[k]);
  if (!e.CODAI_PLATFORM_APP_KEY_FILE && !e.CODAI_PLATFORM_APP_KEY_PEM)
    missing.push('CODAI_PLATFORM_APP_KEY_FILE|CODAI_PLATFORM_APP_KEY_PEM');
  if (missing.length > 0) {
    io.err(`missing env: ${missing.join(', ')}`);
    return 2;
  }
  let pem: string;
  try {
    pem = e.CODAI_PLATFORM_APP_KEY_PEM ?? (await io.readFile(e.CODAI_PLATFORM_APP_KEY_FILE ?? ''));
  } catch {
    io.err('cannot read CODAI_PLATFORM_APP_KEY_FILE');
    return 2;
  }
  let alg: SigningAlg;
  try {
    alg = detectAlg(pem, e.CODAI_PLATFORM_APP_ALG);
  } catch (err) {
    io.err(err instanceof Error ? err.message : 'bad alg');
    return 2;
  }
  const run = io.run ?? runConformance;
  try {
    const report = await run({
      baseUrl: e.CODAI_PLATFORM_URL ?? '',
      appId: e.CODAI_PLATFORM_APP_ID ?? '',
      privateKey: pem.replace(/\\n/g, '\n'),
      alg,
      installationId: e.CODAI_PLATFORM_INSTALLATION_ID ?? '',
      audience: e.CODAI_PLATFORM_AUDIENCE ?? '',
      ...(e.CODAI_PLATFORM_KID ? { kid: e.CODAI_PLATFORM_KID } : {}),
      ...(e.CODAI_PLATFORM_REVISION ? { revision: e.CODAI_PLATFORM_REVISION } : {}),
    });
    io.out(formatConformanceReport(report));
    return report.failed === 0 ? 0 : 1;
  } catch (err) {
    io.err(`conformance run aborted: ${err instanceof Error ? err.name : 'error'}`);
    return 1;
  }
}
