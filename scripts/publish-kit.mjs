// Publishes every platform-kit package whose version is not on npm yet.
// Mode (env NPM_PUBLISH_MODE, default "stage"):
//   stage   -> `npm stage publish`: a maintainer approves each version with 2FA on
//              npmjs.com. Also the only OIDC path that can CREATE a new package name
//              (npm then shows a public 0.0.0-stage placeholder until approval).
//   publish -> `npm publish` (the trusted publisher must allow direct publish).
// Both run under GitHub OIDC trusted publishing with provenance; never a token.
// Run from the mirror root after `pnpm -r build`. Exits non-zero if any publish fails.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.NPM_PUBLISH_MODE === 'publish' ? 'publish' : 'stage';
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));

function onRegistry(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() === version;
  } catch {
    return false;
  }
}

let failed = 0;
for (const [name, version] of Object.entries(versions)) {
  if (onRegistry(name, version)) {
    console.log(`skip    ${name}@${version} (already on npm)`);
    continue;
  }
  const dir = join('packages', name.replace(/^@[^/]+\//, ''));
  // pnpm pack rewrites workspace: specifiers to real versions; npm publishes that tarball.
  const tgz = execFileSync('pnpm', ['pack', '--pack-destination', '../../.tarballs'], { cwd: dir, encoding: 'utf8' })
    .trim()
    .split(/\r?\n/)
    .pop();
  const args = mode === 'stage' ? ['stage', 'publish', tgz, '--access', 'public', '--provenance'] : ['publish', tgz, '--access', 'public', '--provenance'];
  try {
    execFileSync('npm', args, { stdio: 'inherit' });
    console.log(`${mode === 'stage' ? 'staged ' : 'publish'} ${name}@${version}`);
  } catch {
    failed += 1;
    console.error(`FAILED  ${name}@${version}`);
  }
}
process.exit(failed ? 1 : 0);
