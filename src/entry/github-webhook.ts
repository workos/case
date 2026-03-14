import type { TaskCreateRequest, TriggerSource } from '../types.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

// GitHub webhook event payloads (minimal shape we care about)

interface WorkflowRunEvent {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
    html_url: string;
    repository: { full_name: string };
  };
}

interface CheckSuiteEvent {
  action: string;
  check_suite: {
    id: number;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
  };
  repository: { full_name: string; html_url: string };
}

/** Map from GitHub repo full_name to case repo name. */
const REPO_MAP: Record<string, string> = {
  'workos/workos-cli': 'cli',
  'workos/skills': 'skills',
  'workos/authkit-ssr': 'authkit-session',
  'workos/authkit-tanstack-start': 'authkit-tanstack-start',
  'workos/authkit-nextjs': 'authkit-nextjs',
};

/**
 * Verify a GitHub webhook signature (HMAC SHA-256) using Web Crypto.
 * Returns true if valid, false if invalid or no secret configured.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expected = 'sha256=' + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== signature.length) return false;

  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Parse a GitHub webhook event and return a TaskCreateRequest if actionable.
 * Returns null for events we don't care about (success, irrelevant actions).
 */
export function parseGitHubEvent(eventType: string, deliveryId: string, payload: unknown): TaskCreateRequest | null {
  const trigger: TriggerSource = { type: 'webhook', event: eventType, deliveryId };

  switch (eventType) {
    case 'workflow_run':
      return handleWorkflowRun(payload as WorkflowRunEvent, trigger);
    case 'check_suite':
      return handleCheckSuite(payload as CheckSuiteEvent, trigger);
    default:
      log.info('ignoring webhook event', { event: eventType, deliveryId });
      return null;
  }
}

function handleWorkflowRun(event: WorkflowRunEvent, trigger: TriggerSource): TaskCreateRequest | null {
  // Only act on completed, failed workflow runs on the default branch
  if (event.action !== 'completed') return null;
  if (event.workflow_run.conclusion !== 'failure') return null;
  if (event.workflow_run.head_branch !== 'main') return null;

  const repoFullName = event.workflow_run.repository.full_name;
  const repo = REPO_MAP[repoFullName];
  if (!repo) {
    log.info('ignoring workflow_run for unknown repo', { repo: repoFullName });
    return null;
  }

  return {
    repo,
    title: `Fix CI failure: ${event.workflow_run.name}`,
    description: [
      `CI workflow "${event.workflow_run.name}" failed on main.`,
      '',
      `- **Branch:** ${event.workflow_run.head_branch}`,
      `- **SHA:** ${event.workflow_run.head_sha}`,
      `- **Run URL:** ${event.workflow_run.html_url}`,
      '',
      'Investigate the failure, identify the root cause, and fix it.',
    ].join('\n'),
    issueType: 'freeform',
    issue: event.workflow_run.html_url,
    mode: 'unattended',
    trigger,
    autoStart: false, // Require human approval before starting
  };
}

function handleCheckSuite(event: CheckSuiteEvent, trigger: TriggerSource): TaskCreateRequest | null {
  if (event.action !== 'completed') return null;
  if (event.check_suite.conclusion !== 'failure') return null;
  if (event.check_suite.head_branch !== 'main') return null;

  const repoFullName = event.repository.full_name;
  const repo = REPO_MAP[repoFullName];
  if (!repo) return null;

  return {
    repo,
    title: `Fix check suite failure on main`,
    description: [
      `Check suite ${event.check_suite.id} failed on main.`,
      '',
      `- **Branch:** ${event.check_suite.head_branch}`,
      `- **SHA:** ${event.check_suite.head_sha}`,
      '',
      'Investigate and fix the failing checks.',
    ].join('\n'),
    issueType: 'freeform',
    mode: 'unattended',
    trigger,
    autoStart: false,
  };
}
