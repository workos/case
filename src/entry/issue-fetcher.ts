import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { IssueContext } from '../types.js';
import { extractOwnerRepo } from './repo-detector.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

const CREDENTIALS_PATH = resolve(homedir(), '.config/case/credentials');

/**
 * Detect argument type from a CLI positional argument.
 * - Pure digits: GitHub issue number
 * - UPPER-N pattern: Linear issue ID
 * - Anything else: freeform text
 */
export function detectArgumentType(arg: string): 'github' | 'linear' | 'freeform' {
  if (/^\d+$/.test(arg)) return 'github';
  if (/^[A-Z]+-\d+$/.test(arg)) return 'linear';
  return 'freeform';
}

/**
 * Unified issue fetcher — dispatches to the right source based on type.
 */
export async function fetchIssue(
  type: 'github' | 'linear' | 'freeform',
  identifier: string,
  repoRemote?: string,
): Promise<IssueContext> {
  switch (type) {
    case 'github':
      if (!repoRemote) throw new Error('GitHub issue fetch requires a repo remote URL');
      return fetchGitHubIssue(repoRemote, identifier);
    case 'linear':
      return fetchLinearIssue(identifier);
    case 'freeform':
      return freeformIssue(identifier);
  }
}

/**
 * Fetch a GitHub issue via `gh issue view`.
 */
export async function fetchGitHubIssue(repoRemote: string, issueNumber: string): Promise<IssueContext> {
  const ownerRepo = extractOwnerRepo(repoRemote);
  log.info('fetching github issue', { repo: ownerRepo, issue: issueNumber });

  const proc = Bun.spawn(
    ['gh', 'issue', 'view', issueNumber, '--repo', ownerRepo, '--json', 'title,body,labels'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Failed to fetch GitHub issue #${issueNumber} from ${ownerRepo}: ${stderr.trim()}`);
  }

  const data = JSON.parse(stdout) as {
    title: string;
    body: string;
    labels: Array<{ name: string }>;
  };

  return {
    title: data.title,
    body: data.body ?? '',
    labels: data.labels.map((l) => l.name),
    issueType: 'github',
    issueNumber,
  };
}

/**
 * Fetch a Linear issue via GraphQL API.
 * Requires LINEAR_API_KEY in ~/.config/case/credentials.
 */
export async function fetchLinearIssue(issueId: string): Promise<IssueContext> {
  const apiKey = await readLinearApiKey();

  if (!apiKey) {
    throw new Error(
      `LINEAR_API_KEY not found in ${CREDENTIALS_PATH}. Add a line: LINEAR_API_KEY=lin_api_...`,
    );
  }

  log.info('fetching linear issue', { issue: issueId });

  const query = `
    query IssueById($id: String!) {
      issue(id: $id) {
        title
        description
        labels {
          nodes {
            name
          }
        }
        identifier
      }
    }
  `;

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables: { id: issueId } }),
  });

  if (!response.ok) {
    throw new Error(`Linear API returned ${response.status}: ${await response.text()}`);
  }

  const result = (await response.json()) as {
    data?: {
      issue?: {
        title: string;
        description: string;
        labels: { nodes: Array<{ name: string }> };
        identifier: string;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (result.errors?.length) {
    throw new Error(`Linear API error: ${result.errors[0].message}`);
  }

  const issue = result.data?.issue;
  if (!issue) {
    throw new Error(`Linear issue ${issueId} not found`);
  }

  return {
    title: issue.title,
    body: issue.description ?? '',
    labels: issue.labels.nodes.map((l) => l.name),
    issueType: 'linear',
    issueNumber: issue.identifier,
  };
}

/**
 * Construct an IssueContext from freeform text.
 */
export function freeformIssue(text: string): IssueContext {
  return {
    title: text,
    body: text,
    labels: [],
    issueType: 'freeform',
    issueNumber: slugify(text),
  };
}

/** Read LINEAR_API_KEY from credentials file. */
async function readLinearApiKey(): Promise<string | null> {
  try {
    const content = await Bun.file(CREDENTIALS_PATH).text();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === 'LINEAR_API_KEY') return value;
    }
  } catch {
    // File doesn't exist
  }
  return null;
}

/** Simple slug from text for branch naming. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}
