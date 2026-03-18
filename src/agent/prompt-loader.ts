import { resolve } from 'node:path';

export async function loadSystemPrompt(caseRoot: string, agentName: string): Promise<string> {
  const mdPath = resolve(caseRoot, `agents/${agentName}.md`);
  const raw = await Bun.file(mdPath).text();

  // Strip YAML frontmatter (between --- delimiters)
  const stripped = raw.replace(/^---[\s\S]*?---\n*/, '');
  return stripped.trim();
}
