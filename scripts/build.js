import { build } from 'esbuild';
await build({ entryPoints: ['src/index.js'], outfile: 'dist/index.js', bundle: true, platform: 'node', format: 'esm',
  target: 'node24', external: ['openclaw/*'], legalComments: 'linked',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
