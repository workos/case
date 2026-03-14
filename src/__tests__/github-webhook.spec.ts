import { describe, it, expect } from 'bun:test';
import { verifyWebhookSignature, parseGitHubEvent } from '../entry/github-webhook.js';

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret';

  it('returns true for valid signature', async () => {
    const payload = '{"action":"completed"}';
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(await verifyWebhookSignature(payload, `sha256=${hex}`, secret)).toBe(true);
  });

  it('returns false for invalid signature', async () => {
    expect(await verifyWebhookSignature('payload', 'sha256=invalid', secret)).toBe(false);
  });

  it('returns false when no secret configured', async () => {
    expect(await verifyWebhookSignature('payload', 'sha256=sig', undefined)).toBe(false);
  });

  it('returns false when no signature provided', async () => {
    expect(await verifyWebhookSignature('payload', undefined, secret)).toBe(false);
  });
});

describe('parseGitHubEvent', () => {
  it('creates task for failed workflow_run on main', () => {
    const payload = {
      action: 'completed',
      workflow_run: {
        id: 123,
        name: 'CI',
        conclusion: 'failure',
        head_branch: 'main',
        head_sha: 'abc123',
        html_url: 'https://github.com/workos/workos-cli/actions/runs/123',
        repository: { full_name: 'workos/workos-cli' },
      },
    };

    const task = parseGitHubEvent('workflow_run', 'delivery-1', payload);
    expect(task).not.toBeNull();
    expect(task!.repo).toBe('cli');
    expect(task!.title).toContain('CI');
    expect(task!.mode).toBe('unattended');
    expect(task!.autoStart).toBe(false);
  });

  it('ignores successful workflow_run', () => {
    const payload = {
      action: 'completed',
      workflow_run: {
        id: 123,
        name: 'CI',
        conclusion: 'success',
        head_branch: 'main',
        head_sha: 'abc123',
        html_url: 'https://github.com/workos/workos-cli/actions/runs/123',
        repository: { full_name: 'workos/workos-cli' },
      },
    };

    expect(parseGitHubEvent('workflow_run', 'delivery-2', payload)).toBeNull();
  });

  it('ignores non-main branch failures', () => {
    const payload = {
      action: 'completed',
      workflow_run: {
        id: 123,
        name: 'CI',
        conclusion: 'failure',
        head_branch: 'feature-branch',
        head_sha: 'abc123',
        html_url: 'https://github.com/workos/workos-cli/actions/runs/123',
        repository: { full_name: 'workos/workos-cli' },
      },
    };

    expect(parseGitHubEvent('workflow_run', 'delivery-3', payload)).toBeNull();
  });

  it('ignores unknown repos', () => {
    const payload = {
      action: 'completed',
      workflow_run: {
        id: 123,
        name: 'CI',
        conclusion: 'failure',
        head_branch: 'main',
        head_sha: 'abc123',
        html_url: 'https://github.com/unknown/repo/actions/runs/123',
        repository: { full_name: 'unknown/repo' },
      },
    };

    expect(parseGitHubEvent('workflow_run', 'delivery-4', payload)).toBeNull();
  });

  it('ignores unknown event types', () => {
    expect(parseGitHubEvent('push', 'delivery-5', {})).toBeNull();
  });

  it('creates task for failed check_suite on main', () => {
    const payload = {
      action: 'completed',
      check_suite: {
        id: 456,
        conclusion: 'failure',
        head_branch: 'main',
        head_sha: 'def456',
      },
      repository: { full_name: 'workos/authkit-ssr', html_url: 'https://github.com/workos/authkit-ssr' },
    };

    const task = parseGitHubEvent('check_suite', 'delivery-6', payload);
    expect(task).not.toBeNull();
    expect(task!.repo).toBe('authkit-session');
  });
});
