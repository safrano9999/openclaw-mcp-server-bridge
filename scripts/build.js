import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/index.js'], outfile: 'dist/index.js', bundle: true, platform: 'node', format: 'esm', metafile: true,
  target: 'node24', external: ['openclaw/*'], legalComments: 'linked',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
const roots = new Set(Object.keys(result.metafile.inputs).map(input => input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1]).filter(Boolean));
const notices = [];
for (const root of [...roots].sort()) {
  const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  const files = (await readdir(root, { withFileTypes: true })).filter(f => f.isFile() && /^(licen[sc]e|copying|notice)(\.|$)/i.test(f.name));
  if (!files.length) throw Error(`Bundled dependency lacks license text: ${pkg.name}`);
  notices.push(`${pkg.name} ${pkg.version} (${pkg.license ?? 'see below'})\n${(await Promise.all(files.map(f => readFile(`${root}/${f.name}`, 'utf8')))).join('\n')}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n--------------------\n\n'));
