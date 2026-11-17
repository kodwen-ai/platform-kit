#!/usr/bin/env node
/** CLI: run the platform conformance suite against CODAI_PLATFORM_* env and print a table (exit 1 on failure). */
import { runConformanceCli } from './cli-main';

const code = await runConformanceCli({
  env: process.env,
  readFile: async (p) => (await import('node:fs/promises')).readFile(p, 'utf8'),
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
});
process.exitCode = code;
