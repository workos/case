import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { resolvePackageRoot, resolveAgentVersionsDir } from '../paths.js';

export const description = 'Snapshot current agent prompt versions to agent-versions/';

export async function handler(argv: string[]): Promise<number> {
  const agentName = argv[0];
  if (!agentName) {
    process.stderr.write('Usage: ca snapshot <agent-name> --task <task-id> --reason "<why>"\n');
    return 1;
  }

  let taskId = '';
  let reason = '';
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--task') taskId = argv[++i] ?? '';
    else if (argv[i] === '--reason') reason = argv[++i] ?? '';
  }

  const packageRoot = resolvePackageRoot();
  const agentFile = resolve(packageRoot, 'agents', `${agentName}.md`);
  if (!existsSync(agentFile)) {
    process.stderr.write(`Error: agent file not found: ${agentFile}\n`);
    return 1;
  }

  let versionsDir: string;
  const legacyDir = resolve(packageRoot, 'docs', 'agent-versions');
  versionsDir = existsSync(legacyDir) ? legacyDir : resolveAgentVersionsDir();
  mkdirSync(versionsDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const snapBase = `${agentName}-${date}`;
  let snapFile = resolve(versionsDir, `${snapBase}.md`);
  let versionTag = snapBase;

  if (existsSync(snapFile)) {
    let counter = 2;
    while (existsSync(resolve(versionsDir, `${snapBase}-${counter}.md`))) counter++;
    snapFile = resolve(versionsDir, `${snapBase}-${counter}.md`);
    versionTag = `${snapBase}-${counter}`;
  }

  copyFileSync(agentFile, snapFile);
  const contentHash = createHash('sha256').update(readFileSync(agentFile, 'utf-8')).digest('hex').slice(0, 16);

  const entry = {
    version: versionTag,
    agent: agentName,
    date: new Date().toISOString(),
    task: taskId || null,
    reason: reason || null,
    contentHash,
    snapshotFile: resolve(versionsDir, `${versionTag}.md`),
  };
  appendFileSync(resolve(versionsDir, 'changelog.jsonl'), JSON.stringify(entry) + '\n');

  process.stdout.write(`OK: snapshot ${versionTag} → ${basename(snapFile)} (hash: ${contentHash})\n`);
  return 0;
}
