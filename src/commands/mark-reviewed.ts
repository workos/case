import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDataDir, resolvePackageRoot } from '../paths.js';

export const description = 'Mark a repo as reviewed (writes .case/<slug>/reviewed)';

function resolveTaskSlug(): string | null {
  if (!existsSync('.case/active')) return null;
  return readFileSync('.case/active', 'utf-8').trim() || null;
}

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

  const slug = resolveTaskSlug();
  if (!slug) {
    process.stderr.write('ERROR: No active task — .case/active is missing or empty. Run the orchestrator first.\n');
    return 1;
  }

  const markerDir = `.case/${slug}`;
  mkdirSync(markerDir, { recursive: true });
  const timestamp = new Date().toISOString();
  writeFileSync(
    resolve(markerDir, 'reviewed'),
    `timestamp: ${timestamp}\ncritical: ${critical}\nwarnings: ${warnings}\ninfo: ${info}\n`,
  );
  process.stderr.write(`.case/${slug}/reviewed created (${warnings} warnings, ${info} info)\n`);

  let dataRoot: string;
  try {
    dataRoot = resolveDataDir();
  } catch {
    dataRoot = resolvePackageRoot();
  }
  let taskJson = resolve(dataRoot, 'tasks', 'active', `${slug}.task.json`);
  if (!existsSync(taskJson)) taskJson = resolve(resolvePackageRoot(), 'tasks', 'active', `${slug}.task.json`);
  if (existsSync(taskJson)) {
    try {
      const data = JSON.parse(readFileSync(taskJson, 'utf-8'));
      const agents = data.agents ?? {};
      if (!agents.reviewer) agents.reviewer = {};
      agents.reviewer.status = 'completed';
      agents.reviewer.completed = new Date().toISOString();
      data.agents = agents;
      writeFileSync(taskJson, JSON.stringify(data, null, 2) + '\n');
    } catch {
      /* best-effort */
    }
  }
  return 0;
}
