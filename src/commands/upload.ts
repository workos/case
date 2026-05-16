import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { resolveDataDir } from '../paths.js';

export const description = 'Upload a screenshot or video to case-assets, print markdown reference';

function getAssetsRepo(): string {
  if (process.env.ASSETS_REPO) return process.env.ASSETS_REPO;
  let configPath: string | undefined;
  try {
    configPath = resolve(resolveDataDir(), 'config.json');
  } catch {
    /* no data dir */
  }
  if (configPath && existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.assetsRepo) return config.assetsRepo;
    } catch {
      /* malformed config */
    }
  }
  return 'nicknisi/case-assets';
}

const RELEASE_TAG = 'assets';

async function ghRun(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

async function ensureRelease(repo: string): Promise<void> {
  const check = await ghRun(['release', 'view', RELEASE_TAG, '--repo', repo]);
  if (check.exitCode !== 0) {
    process.stderr.write(`Creating release '${RELEASE_TAG}' in ${repo}...\n`);
    await ghRun([
      'release',
      'create',
      RELEASE_TAG,
      '--repo',
      repo,
      '--title',
      'PR Assets',
      '--notes',
      'Screenshots and videos for PR descriptions. Uploaded by case harness.',
    ]);
  }
}

async function uploadAsset(file: string, repo: string): Promise<string | null> {
  const name = basename(file);
  await ghRun(['release', 'upload', RELEASE_TAG, file, '--repo', repo, '--clobber']);
  const { stdout } = await ghRun([
    'release',
    'view',
    RELEASE_TAG,
    '--repo',
    repo,
    '--json',
    'assets',
    '--jq',
    `.assets[] | select(.name == "${name}") | .url`,
  ]);
  return stdout || null;
}

export async function handler(argv: string[]): Promise<number> {
  const ghCheck = Bun.spawn(['gh', '--version'], { stdout: 'ignore', stderr: 'ignore' });
  if ((await ghCheck.exited) !== 0) {
    process.stderr.write('gh CLI not found. Install: https://cli.github.com/\n');
    return 1;
  }

  const filePath = argv.find((a) => !a.startsWith('--'));
  if (!filePath || !existsSync(filePath)) {
    process.stderr.write(`upload: file not found: ${filePath ?? '<none>'}\n`);
    return 1;
  }

  const repo = getAssetsRepo();
  const ext = extname(filePath).slice(1).toLowerCase();
  const filename = basename(filePath);
  await ensureRelease(repo);

  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    process.stderr.write(`Uploading ${filename}...\n`);
    const url = await uploadAsset(filePath, repo);
    if (!url) {
      process.stderr.write(`Failed to get download URL for ${filename}\n`);
      return 1;
    }
    process.stdout.write(`![${filename}](${url})\n`);
  } else if (['mp4', 'mov', 'webm'].includes(ext)) {
    let mp4Path = filePath;
    if (ext === 'webm') {
      const ffmpegCheck = Bun.spawn(['which', 'ffmpeg'], { stdout: 'ignore', stderr: 'ignore' });
      if ((await ffmpegCheck.exited) === 0) {
        const stem = basename(filePath, `.${ext}`);
        mp4Path = `/tmp/${stem}.mp4`;
        process.stderr.write('Converting webm to mp4...\n');
        const convert = Bun.spawn(
          [
            'ffmpeg',
            '-y',
            '-i',
            filePath,
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            mp4Path,
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        await convert.exited;
      }
    }
    process.stderr.write('Uploading video...\n');
    const url = await uploadAsset(mp4Path, repo);
    if (!url) {
      process.stderr.write('Failed to get download URL\n');
      return 1;
    }
    process.stdout.write(`[▶ Download verification video](${url})\n`);
  } else {
    process.stderr.write(`Uploading ${filename}...\n`);
    const url = await uploadAsset(filePath, repo);
    if (!url) {
      process.stderr.write(`Failed to get download URL for ${filename}\n`);
      return 1;
    }
    process.stdout.write(`[${filename}](${url})\n`);
  }
  return 0;
}
