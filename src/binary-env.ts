import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const isBunBinary =
  typeof import.meta.url === 'string' &&
  (import.meta.url.includes('$bunfs') || import.meta.url.includes('~BUN') || import.meta.url.includes('%7EBUN'));

if (isBunBinary && !process.env.PI_PACKAGE_DIR) {
  const assetDir = preparePiAssetDir();
  process.env.PI_PACKAGE_DIR = assetDir;
}

function preparePiAssetDir(): string {
  let lastError: unknown;
  for (const assetDir of candidatePiAssetDirs()) {
    try {
      mkdirSync(assetDir, { recursive: true });
      const manifestPath = join(assetDir, 'package.json');
      if (!existsSync(manifestPath)) {
        writeFileSync(
          manifestPath,
          JSON.stringify({
            name: '@mariozechner/pi-coding-agent',
            version: '0.0.0-case-binary',
            piConfig: { name: 'pi', configDir: '.pi' },
          }) + '\n',
        );
      }
      return assetDir;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to prepare PI_PACKAGE_DIR');
}

function candidatePiAssetDirs(): string[] {
  const candidates: string[] = [];
  if (process.env.CASE_DATA_DIR) candidates.push(join(process.env.CASE_DATA_DIR, 'pi-package'));
  if (process.env.XDG_CONFIG_HOME) candidates.push(join(process.env.XDG_CONFIG_HOME, 'case', 'pi-package'));
  const home = process.env.HOME || homedir();
  if (home) candidates.push(join(home, '.config', 'case', 'pi-package'));
  candidates.push(join(dirname(process.execPath), '.case', 'pi-package'));
  candidates.push(join(tmpdir(), 'case', 'pi-package'));
  return candidates;
}
