import { createLogger } from './logger.js';

const log = createLogger();

export interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a script safely via Bun.spawn (no shell injection).
 * Always returns a structured result — never throws.
 */
export async function runScript(
  scriptPath: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<ScriptResult> {
  const timeout = options?.timeout ?? 30_000;
  const start = Date.now();

  try {
    const proc = Bun.spawn([scriptPath, ...args], {
      cwd: options?.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timer = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    const level = exitCode === 0 ? 'info' : 'error';
    log[level](exitCode === 0 ? 'script completed' : 'script failed', {
      script: scriptPath,
      args,
      durationMs: Date.now() - start,
      exitCode,
    });

    return { stdout, stderr, exitCode };
  } catch (err: unknown) {
    const e = err as Error;

    log.error('script failed', {
      script: scriptPath,
      args,
      durationMs: Date.now() - start,
      exitCode: 1,
      error: e.message,
    });

    return {
      stdout: '',
      stderr: e.message ?? '',
      exitCode: 1,
    };
  }
}
