import { dirname } from 'node:path';

const isBunBinary =
  typeof import.meta.url === 'string' &&
  (import.meta.url.includes('$bunfs') ||
    import.meta.url.includes('~BUN') ||
    import.meta.url.includes('%7EBUN'));

if (isBunBinary && !process.env.PI_PACKAGE_DIR) {
  process.env.PI_PACKAGE_DIR = dirname(process.execPath);
}
