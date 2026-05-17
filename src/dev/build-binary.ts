import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePackageAssets } from './generate-package-assets.js';

const root = resolve(import.meta.dir, '..', '..');
const dist = resolve(root, 'dist');
const outfile = resolve(dist, 'ca');

await generatePackageAssets(root);
rmSync(dist, { recursive: true, force: true });

const proc = Bun.spawn(['bun', 'build', '--compile', resolve(root, 'src/index.ts'), '--outfile', outfile], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});

const code = await proc.exited;
if (code !== 0) process.exit(code);

process.stdout.write(`Binary: ${outfile}\n`);
process.stdout.write(`Test:   ${outfile} --help\n`);
