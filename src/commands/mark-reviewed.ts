import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveFocusedTask } from '../state/td-client.js';
import { TaskStore } from '../state/task-store.js';

export const description = 'Mark a repo as reviewed (writes .case/<slug>/reviewed)';

export async function handler(argv: string[]): Promise<number> {
  let critical = 0;
  let warnings = 0;
  let info = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--critical') critical = parseInt(argv[++i] ?? '0', 10);
    else if (argv[i] === '--warnings') warnings = parseInt(argv[++i] ?? '0', 10);
    else if (argv[i] === '--info') info = parseInt(argv[++i] ?? '0', 10);
  }

  if (critical > 0) {
    process.stderr.write(`ERROR: Cannot create reviewed marker with ${critical} critical findings\n`);
    return 1;
  }

  const focused = await resolveFocusedTask(process.cwd());
  if (!focused) {
    process.stderr.write('ERROR: No active task — no focused td task. Run the orchestrator first.\n');
    return 1;
  }
  const slug = focused.task.id;

  const markerDir = `.case/${slug}`;
  mkdirSync(markerDir, { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(
    resolve(markerDir, 'reviewed'),
    `timestamp: ${timestamp}\ncritical: ${critical}\nwarnings: ${warnings}\ninfo: ${info}\n`,
  );
  process.stderr.write(`.case/${slug}/reviewed created (${warnings} warnings, ${info} info)\n`);

  try {
    const agents = { ...focused.task.agents };
    agents.reviewer = {
      ...(agents.reviewer ?? { started: null }),
      status: 'completed',
      completed: new Date().toISOString(),
    };
    await new TaskStore(process.cwd(), focused.tdId).writeFromProjection({ agents });
  } catch {
    /* best-effort */
  }
  return 0;
}
