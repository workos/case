import { readPackageAsset } from '../package-assets.js';

export async function loadSystemPrompt(caseRoot: string, agentName: string): Promise<string> {
  const raw = await readPackageAsset(`agents/${agentName}.md`, { packageRoot: caseRoot });

  // Strip YAML frontmatter (between --- delimiters)
  const stripped = raw.replace(/^---[\s\S]*?---\n*/, '');
  return stripped.trim();
}
