import { createLogger } from './logger.js';

const log = createLogger();

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandOptions {
  cwd?: string;
  timeout?: number;
}

/**
 * Parse a simple command line into argv without invoking a shell.
 * Supports whitespace, single quotes, double quotes, and backslash escapes.
 */
export function parseCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of commandLine) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += '\\';
  if (quote) throw new Error(`Unterminated ${quote} quote in command: ${commandLine}`);
  if (current) args.push(current);
  return args;
}

export async function runCommand(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
  const timeout = options?.timeout ?? 30_000;
  const start = Date.now();

  try {
    const proc = Bun.spawn([command, ...args], {
      cwd: options?.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timer = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    const level = exitCode === 0 ? 'info' : 'error';
    log[level](exitCode === 0 ? 'command completed' : 'command failed', {
      command,
      args,
      durationMs: Date.now() - start,
      exitCode,
    });

    return { stdout, stderr, exitCode };
  } catch (err: unknown) {
    const e = err as Error;
    log.error('command failed', {
      command,
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

export async function runCommandLine(commandLine: string, options?: CommandOptions): Promise<CommandResult> {
  const argv = parseCommandLine(commandLine);
  if (argv.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
  return runCommand(argv[0]!, argv.slice(1), options);
}
