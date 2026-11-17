import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server.ts',
    'src/hono.ts',
    'src/next.ts',
    'src/client.ts',
    'src/conformance.ts',
    'src/conformance-cli.ts',
  ],
  format: ['esm'],
  platform: 'neutral',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: 'es2022',
  outDir: 'dist',
  tsconfig: 'tsconfig.build.json',
});
