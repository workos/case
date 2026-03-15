import { resolve } from 'node:path';
import type { AgentMetadata } from '../types.js';

const cache = new Map<string, AgentMetadata>();

/** Parse YAML frontmatter from an agent .md file's content. */
export function parseFrontmatter(content: string): AgentMetadata {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('No frontmatter found — expected --- delimiters');
  }

  const block = match[1];

  const name = extractField(block, 'name');
  if (!name) throw new Error('Frontmatter missing required field: name');

  const description = extractField(block, 'description') ?? '';

  const toolsRaw = extractField(block, 'tools');
  if (!toolsRaw) throw new Error('Frontmatter missing required field: tools');

  const tools = parseToolsArray(toolsRaw);
  if (tools.length === 0) throw new Error('Frontmatter tools array is empty');

  const model = extractField(block, 'model') ?? undefined;

  return { name, description, tools, model };
}

/** Load and cache agent metadata from an agent .md file. */
export async function loadAgentMetadata(caseRoot: string, agentName: string): Promise<AgentMetadata> {
  if (cache.has(agentName)) return cache.get(agentName)!;

  const agentPath = resolve(caseRoot, `agents/${agentName}.md`);
  const content = await Bun.file(agentPath).text();
  const metadata = parseFrontmatter(content);

  if (metadata.name !== agentName) {
    throw new Error(`Agent file name "${agentName}" does not match frontmatter name "${metadata.name}"`);
  }

  cache.set(agentName, metadata);
  return metadata;
}

/** Clear the metadata cache (for testing). */
export function clearMetadataCache(): void {
  cache.clear();
}

function extractField(block: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const match = block.match(regex);
  return match ? match[1].trim() : null;
}

function parseToolsArray(raw: string): string[] {
  // Format: ['Read', 'Edit', 'Write'] or ["Read", "Edit", "Write"]
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}
