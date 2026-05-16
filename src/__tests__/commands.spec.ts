import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { rm, writeFile, chmod } from 'node:fs/promises';
import { commandMap, dispatch, suggest, printHelp } from '../commands/index.js';
import { spawnScript } from '../commands/spawn.js';

/**
 * Capture process.stdout / process.stderr writes.
 *
 * Pattern: replace `.write` with a spy that pushes into a string array.
 * Restore in afterEach.
 */
function captureStream(stream: NodeJS.WriteStream): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = stream.write.bind(stream);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (stream as any).write = (chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  };
  return {
    lines,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stream as any).write = original;
    },
  };
}

describe('commandMap registration', () => {
  it('registers all 11 expected verbs', () => {
    const expected = [
      'run',
      'watch',
      'create',
      'serve',
      'session',
      'status',
      'mark-tested',
      'mark-manual-tested',
      'mark-reviewed',
      'upload',
      'snapshot',
    ];
    for (const verb of expected) {
      expect(commandMap[verb]).toBeDefined();
      expect(typeof commandMap[verb]!.handler).toBe('function');
      expect(typeof commandMap[verb]!.description).toBe('string');
      expect(commandMap[verb]!.description.length).toBeGreaterThan(0);
    }
  });
});

describe('suggest', () => {
  const verbs = Object.keys(commandMap);

  it('returns closest verb for typo within distance 2', () => {
    expect(suggest('statis', verbs)).toBe('status');
    expect(suggest('sesion', verbs)).toBe('session');
    expect(suggest('snapsho', verbs)).toBe('snapshot');
  });

  it('returns undefined when nothing is close', () => {
    expect(suggest('zzzzzzz', verbs)).toBeUndefined();
  });

  it('returns exact match when input equals a verb', () => {
    expect(suggest('status', verbs)).toBe('status');
  });
});

describe('dispatch — help and routing', () => {
  let outCapture: ReturnType<typeof captureStream>;
  let errCapture: ReturnType<typeof captureStream>;

  beforeEach(() => {
    outCapture = captureStream(process.stdout);
    errCapture = captureStream(process.stderr);
  });

  afterEach(() => {
    outCapture.restore();
    errCapture.restore();
  });

  it('--help exits 0 and lists every verb', async () => {
    const code = await dispatch(['--help']);
    expect(code).toBe(0);
    const help = outCapture.lines.join('');
    for (const verb of Object.keys(commandMap)) {
      expect(help).toContain(verb);
    }
  });

  it('-h is an alias for --help', async () => {
    const code = await dispatch(['-h']);
    expect(code).toBe(0);
    expect(outCapture.lines.join('')).toContain('Commands:');
  });

  it('unknown verb exits 1 and suggests closest', async () => {
    // Stub the run handler to avoid kicking off the real pipeline if dispatch falls through.
    const code = await dispatch(['statis']);
    expect(code).toBe(1);
    const stderr = errCapture.lines.join('');
    expect(stderr).toContain("unknown command 'statis'");
    expect(stderr).toContain("did you mean 'status'");
  });

  it('unknown verb without close match still exits 1', async () => {
    const code = await dispatch(['zzzzzzzzz']);
    expect(code).toBe(1);
    expect(errCapture.lines.join('')).toContain("unknown command 'zzzzzzzzz'");
  });

  it('flag-only argv (no verb) routes to run handler', async () => {
    // Stub the run handler so we don't actually run the pipeline.
    const original = commandMap.run!.handler;
    let receivedArgv: string[] | undefined;
    commandMap.run!.handler = async (argv) => {
      receivedArgv = argv;
      return 0;
    };
    try {
      const code = await dispatch(['--task', 'foo.json']);
      expect(code).toBe(0);
      expect(receivedArgv).toEqual(['--task', 'foo.json']);
    } finally {
      commandMap.run!.handler = original;
    }
  });

  it('empty argv routes to run handler with empty args', async () => {
    const original = commandMap.run!.handler;
    let invoked = false;
    let receivedArgv: string[] | undefined;
    commandMap.run!.handler = async (argv) => {
      invoked = true;
      receivedArgv = argv;
      return 0;
    };
    try {
      const code = await dispatch([]);
      expect(code).toBe(0);
      expect(invoked).toBe(true);
      expect(receivedArgv).toEqual([]);
    } finally {
      commandMap.run!.handler = original;
    }
  });

  it('dispatches verb with args to its handler', async () => {
    const original = commandMap.status!.handler;
    let receivedArgv: string[] | undefined;
    commandMap.status!.handler = async (argv) => {
      receivedArgv = argv;
      return 42;
    };
    try {
      const code = await dispatch(['status', 'get', '--task', 'foo']);
      expect(code).toBe(42);
      expect(receivedArgv).toEqual(['get', '--task', 'foo']);
    } finally {
      commandMap.status!.handler = original;
    }
  });

  it('propagates the handler exit code', async () => {
    const original = commandMap.snapshot!.handler;
    commandMap.snapshot!.handler = async () => 7;
    try {
      expect(await dispatch(['snapshot'])).toBe(7);
    } finally {
      commandMap.snapshot!.handler = original;
    }
  });
});

describe('printHelp', () => {
  it('lists each verb on its own line with description', () => {
    const out = captureStream(process.stdout);
    try {
      printHelp();
    } finally {
      out.restore();
    }
    const text = out.lines.join('');
    expect(text).toContain('mark-tested');
    expect(text).toContain('SHA-256');
    expect(text).toContain('Snapshot current agent prompt versions');
  });
});

describe('spawnScript', () => {
  it('runs a real packaged script and returns its exit code', async () => {
    // session-start.sh is shipped under scripts/ and defaults its repo path
    // to ".", which exists when bun test runs from the case repo. The exit
    // code may be 0 or non-zero depending on local git state — we only
    // assert that the spawn round-trip produced a numeric result.
    const code = await spawnScript('session-start.sh', []);
    expect(typeof code).toBe('number');
  });

  it('throws Error with full path when script is missing', async () => {
    let threw = false;
    let message = '';
    try {
      await spawnScript('nonexistent-script-xyz.sh', []);
    } catch (err) {
      threw = true;
      message = (err as Error).message;
    }
    expect(threw).toBe(true);
    expect(message).toContain('Script not found');
    expect(message).toContain('nonexistent-script-xyz.sh');
  });

  it('auto-chmods a non-executable script and retries', async () => {
    // Drop a script into the real scripts/ directory under a guaranteed
    // unique name, strip the exec bit, and verify spawnScript fixes it.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { resolvePackageRoot } = await import('../paths.js');
    const root = resolvePackageRoot();
    const scriptPath = path.resolve(root, 'scripts', '__test-autochmod.sh');
    await writeFile(scriptPath, '#!/usr/bin/env bash\nexit 0\n');
    await chmod(scriptPath, 0o644);
    try {
      const code = await spawnScript('__test-autochmod.sh', []);
      expect(code).toBe(0);
      // Verify the bit was set.
      const stats = await fs.stat(scriptPath);
      expect(stats.mode & 0o111).not.toBe(0);
    } finally {
      await rm(scriptPath, { force: true });
    }
  });
});

describe('mark-tested handler', () => {
  let originalIsTTY: boolean | undefined;
  let errCapture: ReturnType<typeof captureStream>;

  beforeEach(() => {
    // process.stdin.isTTY is undefined or boolean depending on environment.
    originalIsTTY = process.stdin.isTTY;
    errCapture = captureStream(process.stderr);
  });

  afterEach(() => {
    // Restore the prior value (may be undefined).
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
    errCapture.restore();
  });

  it('TTY guard exits 1 with usage hint when stdin is a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
      writable: true,
    });

    const { handler } = await import('../commands/mark-tested.js');
    const code = await handler(['--repo', '/tmp/x']);
    expect(code).toBe(1);
    const stderr = errCapture.lines.join('');
    expect(stderr).toContain('mark-tested requires test output on stdin');
  });
});

describe('upload handler — preflight checks', () => {
  let errCapture: ReturnType<typeof captureStream>;

  beforeEach(() => {
    errCapture = captureStream(process.stderr);
  });

  afterEach(() => {
    errCapture.restore();
  });

  it('exits 1 with file-not-found message when path is missing', async () => {
    const { handler } = await import('../commands/upload.js');
    // If gh CLI is not present in CI, this still exits 1 — both code paths
    // return 1, so we assert on exit code and accept either error message.
    const code = await handler(['/nonexistent/path/to/screenshot.png']);
    expect(code).toBe(1);
    const stderr = errCapture.lines.join('');
    // Accept either preflight failure (gh missing OR file missing).
    expect(
      stderr.includes('upload: file not found') || stderr.includes('gh CLI not found'),
    ).toBe(true);
  });

  it('exits 1 when no positional file path is provided', async () => {
    const { handler } = await import('../commands/upload.js');
    const code = await handler(['--type', 'screenshot']);
    expect(code).toBe(1);
  });
});

describe('command modules — argv forwarding (smoke)', () => {
  // These confirm that each thin wrapper resolves to spawnScript with the
  // expected script name. We mock spawn.ts via Bun's `mock.module` so we
  // don't actually spawn child processes during unit tests.

  beforeEach(() => {
    mock.module('../commands/spawn.js', () => ({
      spawnScript: (name: string, args: string[]) => {
        // Round-trip the call signature as the resolved value so the
        // calling test can introspect it.
        return Promise.resolve({ name, args } as unknown as number);
      },
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  it('session forwards argv to session-start.sh', async () => {
    const mod = await import('../commands/session.js');
    const result = (await mod.handler(['--foo'])) as unknown as { name: string; args: string[] };
    expect(result.name).toBe('session-start.sh');
    expect(result.args).toEqual(['--foo']);
  });

  it('status forwards argv to task-status.sh', async () => {
    const mod = await import('../commands/status.js');
    const result = (await mod.handler(['get'])) as unknown as { name: string; args: string[] };
    expect(result.name).toBe('task-status.sh');
    expect(result.args).toEqual(['get']);
  });

  it('mark-manual-tested forwards argv to mark-manual-tested.sh', async () => {
    const mod = await import('../commands/mark-manual-tested.js');
    const result = (await mod.handler(['--repo', '/x'])) as unknown as {
      name: string;
      args: string[];
    };
    expect(result.name).toBe('mark-manual-tested.sh');
    expect(result.args).toEqual(['--repo', '/x']);
  });

  it('mark-reviewed forwards argv to mark-reviewed.sh', async () => {
    const mod = await import('../commands/mark-reviewed.js');
    const result = (await mod.handler(['--repo', '/x'])) as unknown as {
      name: string;
      args: string[];
    };
    expect(result.name).toBe('mark-reviewed.sh');
    expect(result.args).toEqual(['--repo', '/x']);
  });

  it('snapshot forwards argv to snapshot-agent.sh', async () => {
    const mod = await import('../commands/snapshot.js');
    const result = (await mod.handler([])) as unknown as { name: string; args: string[] };
    expect(result.name).toBe('snapshot-agent.sh');
    expect(result.args).toEqual([]);
  });
});
