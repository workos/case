import { runSequence } from './run-sequence.js';

await runSequence([
  { label: 'target ast rules', args: ['bun', 'run', 'lint:ast'] },
  { label: 'self ast rules', args: ['bun', 'run', 'lint:ast:self'] },
  { label: 'path lint', args: ['bun', 'run', 'lint:paths'] },
]);
