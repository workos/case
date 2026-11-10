import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import applySeccompArm64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp' with { type: 'file' };
import applySeccompX64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp' with { type: 'file' };
import {
  createBashTool,
  createEditTool,
  createLocalBashOperations,
  createReadTool,
  createWriteTool,
} from '@mariozechner/pi-coding-agent';
import type { BashOperations } from '@mariozechner/pi-coding-agent';
import { spawnSync } from 'node:child_process';
import {
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { resolveDataDir } from '../paths.js';

// ponytail: guessed egress allowlist (npm installs, WorkOS API, AuthKit hosted login). Widen here if a repo's verification needs more.
const ALLOWED_DOMAINS = ['registry.npmjs.org', 'api.workos.com', '*.authkit.app'];

const PASS_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|LANG|LC_\w+|TZ|NO_COLOR|FORCE_COLOR|CI|XDG_(CONFIG|CACHE|DATA|STATE)_HOME|CASE_\w+)$/;

/** Credential and auth locations hidden from every agent role, in bash and in the file tools. */
function hiddenPaths(): string[] {
  // Bun's homedir() ignores $HOME, which is what `~` means to the sandboxed shell; cover both.
  const homes = [...new Set([process.env.HOME, homedir()].filter((home): home is string => !!home))];
  const configHome = process.env.XDG_CONFIG_HOME;
  return homes.flatMap((home) => [
    ...[
      '.ssh',
      '.gnupg',
      '.aws',
      '.azure',
      '.kube',
      '.docker',
      '.netrc',
      '.npmrc',
      '.yarnrc.yml',
      '.pypirc',
      '.git-credentials',
      '.gitconfig',
      '.pi',
      '.claude',
      '.local/share/keyrings',
      'Library/Keychains',
      '.bashrc',
      '.bash_profile',
      '.profile',
      '.zshrc',
      '.zshenv',
      '.zprofile',
    ].map((p) => join(home, p)),
    ...['gh', 'git', 'gcloud'].map((p) => join(configHome || join(home, '.config'), p)),
  ]);
}

const writeRoots = (cwd: string) => [cwd, '/tmp', tmpdir()];

/** Pi loads extensions and settings from these, so agents must never write them. */
function piConfigDirs(cwd: string): string[] {
  return [join(cwd, '.pi'), join(process.cwd(), '.pi'), process.env.PI_CODING_AGENT_DIR].filter(
    (dir): dir is string => !!dir,
  );
}

/** In a compiled `ca` binary the vendored seccomp helper lives in Bun's virtual FS, but bwrap needs it on disk. */
function seccompApplyPath(): string | undefined {
  const embedded = process.arch === 'arm64' ? applySeccompArm64 : applySeccompX64;
  if (process.platform !== 'linux' || !embedded.includes('$bunfs')) return undefined;
  // Outside the sandbox's write roots, so agents can't swap the helper out.
  const target = join(resolveDataDir(), 'bin', `apply-seccomp-${process.arch}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.${process.pid}`, readFileSync(embedded), { mode: 0o755 });
  renameSync(`${target}.${process.pid}`, target);
  return target;
}

let ready: Promise<void> | undefined;

function ensureSandbox(): Promise<void> {
  ready ??= (async () => {
    if (!SandboxManager.isSupportedPlatform()) {
      throw new Error(`Agent bash sandbox is not supported on ${process.platform}`);
    }
    // sandbox-runtime points TMPDIR inside the sandbox here; its /tmp/claude default may not exist.
    const sandboxTmp = mkdtempSync(join(tmpdir(), 'case-sandbox-'));
    process.env.CLAUDE_CODE_TMPDIR = sandboxTmp;
    process.once('exit', () => rmSync(sandboxTmp, { recursive: true, force: true }));
    await SandboxManager.initialize({
      network: { allowedDomains: ALLOWED_DOMAINS, deniedDomains: [], allowLocalBinding: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      seccomp: { applyPath: seccompApplyPath() },
    });
    // Without seccomp, Linux sandboxes can still reach host Unix sockets (docker, ssh-agent, D-Bus).
    const { errors, warnings } = SandboxManager.checkDependencies();
    const problems = [...errors, ...warnings.filter((warning) => warning.includes('seccomp'))];
    if (problems.length > 0) {
      await SandboxManager.reset();
      throw new Error(
        `Agent bash sandbox unavailable (${problems.join('; ')}). Install bubblewrap, socat and ripgrep on Linux, or ripgrep on macOS.`,
      );
    }
  })();
  return ready;
}

/** Git dirs outside the repo (worktrees) must be writable for commits; hooks and config never are. */
function gitDirs(cwd: string): { writable: string[]; protected: string[] } {
  const out = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  const [gitDir, commonDir] = out.status === 0 ? out.stdout.trim().split('\n') : [];
  if (!gitDir || !commonDir) return { writable: [], protected: [] };
  return {
    writable: [gitDir, commonDir],
    protected: [join(commonDir, 'hooks'), join(commonDir, 'config'), join(gitDir, 'config.worktree')],
  };
}

function sandboxEnv(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([key]) => PASS_ENV.test(key)));
  // ~/.gitconfig is hidden, so give git an empty global config and forward only the commit identity.
  out.GIT_CONFIG_GLOBAL = '/dev/null';
  out.GIT_CONFIG_NOSYSTEM = '1';
  const identity = spawnSync('git', ['config', '--get-regexp', '^user\\.(name|email)$'], { cwd, encoding: 'utf8' });
  for (const line of (identity.stdout ?? '').split('\n')) {
    const [, key, value] = line.match(/^user\.(name|email) (.+)$/) ?? [];
    if (key && value) out[`GIT_AUTHOR_${key.toUpperCase()}`] = out[`GIT_COMMITTER_${key.toUpperCase()}`] = value;
  }
  return out;
}

const localBash = createLocalBashOperations();

const sandboxedBash: BashOperations = {
  async exec(command, cwd, options) {
    await ensureSandbox();
    const git = gitDirs(cwd);
    const wrapped = await SandboxManager.wrapWithSandbox(
      command,
      undefined,
      {
        filesystem: {
          denyRead: hiddenPaths(),
          allowWrite: [...writeRoots(cwd), ...git.writable],
          denyWrite: [...git.protected, ...piConfigDirs(cwd)],
        },
      },
      options.signal,
    );
    try {
      return await localBash.exec(wrapped, cwd, { ...options, env: sandboxEnv(options.env ?? process.env, cwd) });
    } finally {
      SandboxManager.cleanupAfterCommand();
    }
  },
};

function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolveReal(parent), basename(path));
  }
}

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

// ponytail: paths are checked via realpath and then opened by that real path; a concurrent symlink swap of a
// parent directory can still race the check. Upgrade to per-component O_NOFOLLOW opens if that matters.
function readablePath(path: string): string {
  const real = resolveReal(path);
  if ([...hiddenPaths(), '/proc'].some((hidden) => within(real, resolveReal(hidden)))) {
    throw new Error(`Access denied: ${path}`);
  }
  return real;
}

/** Real path of a file an agent may write: inside the repo or /tmp, never git internals or Pi config. */
export function writablePath(path: string, cwd: string): string {
  const real = readablePath(path);
  if (!writeRoots(cwd).some((root) => within(real, resolveReal(root)))) {
    throw new Error(`Write denied outside the working repo and /tmp: ${path}`);
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (
    real.split(sep).some((part) => part === '.git' || part === '.pi') ||
    (agentDir && within(real, resolveReal(agentDir)))
  ) {
    throw new Error(`Write denied: ${path} is protected`);
  }
  return real;
}

async function imageMimeType(path: string): Promise<string | null> {
  const file = await open(path, 'r');
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(12), 0, 12, 0);
    const hex = buffer.subarray(0, bytesRead).toString('hex');
    if (hex.startsWith('89504e47')) return 'image/png';
    if (hex.startsWith('ffd8ff')) return 'image/jpeg';
    if (hex.startsWith('47494638')) return 'image/gif';
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'image/webp';
    return null;
  } finally {
    await file.close();
  }
}

export const createSandboxedBashTool = (cwd: string) => createBashTool(cwd, { operations: sandboxedBash });

export const createGuardedReadTool = (cwd: string) =>
  createReadTool(cwd, {
    operations: {
      readFile: (path) => readFile(readablePath(path)),
      access: (path) => access(readablePath(path), constants.R_OK),
      detectImageMimeType: (path) => imageMimeType(readablePath(path)),
    },
  });

export const createGuardedWriteTool = (cwd: string) =>
  createWriteTool(cwd, {
    operations: {
      writeFile: (path, content) => writeFile(writablePath(path, cwd), content, 'utf-8'),
      mkdir: async (dir) => {
        await mkdir(writablePath(dir, cwd), { recursive: true });
      },
    },
  });

export const createGuardedEditTool = (cwd: string) =>
  createEditTool(cwd, {
    operations: {
      readFile: (path) => readFile(writablePath(path, cwd)),
      writeFile: (path, content) => writeFile(writablePath(path, cwd), content, 'utf-8'),
      access: (path) => access(writablePath(path, cwd), constants.R_OK | constants.W_OK),
    },
  });
