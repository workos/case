import { runSequence } from './run-sequence.js';

await runSequence([
  { label: 'unit tests', args: ['bun', 'test', './src/__tests__/'] },
  { label: 'standalone tests', args: ['bun', 'test', '--cwd', 'test/standalone'] },
]);
