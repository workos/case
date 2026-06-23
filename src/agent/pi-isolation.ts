import { mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@mariozechner/pi-coding-agent';

/**
 * Files/dirs under the user's `~/.pi/agent` that carry provider + auth config.
 * These are the *only* things linked into an isolated runtime — everything else
 * (global `extensions/`, `themes/`, `tools/`, statusline) is intentionally left
 * behind so a clean slate is loaded.
 *
 * - `auth.json`     — OAuth tokens / API keys. Linked (not copied) so token
 *                     refreshes write back to the real file.
 * - `settings.json` — `packages`, `defaultProvider`, `defaultModel`. Without it,
 *                     pi never learns which provider serves the default model.
 * - `npm`           — installed provider-extension packages (e.g. a gateway
 *                     provider that authorizes the configured default model).
 *                     pi resolves user-scope npm packages under `<agentDir>/npm`.
 */
const PRESERVED_CONFIG = ['auth.json', 'settings.json', 'npm'] as const;

/**
 * When set, pi runs with `--no-extensions` semantics: no package extensions
 * (including the provider gateway) are loaded, and only auth.json is linked
 * into isolation. Use this to run a vanilla pi against a built-in provider —
 * requires ANTHROPIC_API_KEY (or a real OAuth auth.json), since the gateway
 * provider is no longer there to authorize the default model.
 */
export function piExtensionsDisabled(): boolean {
  const v = process.env.CASE_PI_NO_EXTENSIONS;
  return v === '1' || v === 'true';
}

export interface IsolatedPiRuntime {
  /** The user's real `~/.pi/agent` directory (captured before redirection). */
  realAgentDir: string;
  /** The temp directory pi now treats as its agent dir. */
  isolatedAgentDir: string;
}

/**
 * Point pi at an isolated agent dir so it loads none of the user's global
 * extensions, themes, statusline, or tools — while preserving the config pi
 * needs to resolve model credentials.
 *
 * Only auth.json was previously linked, which broke any user whose default
 * model is served by an extension provider (a local gateway, a proxy): in
 * isolation that provider disappeared, pi fell back to a built-in provider with
 * no key, and the session died with "No API key found for <provider>". Linking
 * settings.json and the npm package dir restores the provider without dragging
 * in the noisy global extensions that motivated isolation in the first place.
 *
 * Sets `PI_CODING_AGENT_DIR` (and `PI_SKIP_VERSION_CHECK`) as a side effect;
 * call this before any pi API that reads the agent dir.
 *
 * @param label Short tag used in the temp dir name (e.g. `orchestrator`).
 */
export function isolatePiRuntime(label: string): IsolatedPiRuntime {
  const realAgentDir = getAgentDir();
  const isolatedAgentDir = `${process.env.TMPDIR ?? '/tmp'}/case-${label}-pi-${process.pid}`;
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  process.env.PI_SKIP_VERSION_CHECK = '1';

  mkdirSync(isolatedAgentDir, { recursive: true });

  // With extensions disabled the gateway provider won't load, so its config is
  // pointless — link only auth.json so a real key / OAuth auth.json still works.
  const preserved = piExtensionsDisabled() ? (['auth.json'] as const) : PRESERVED_CONFIG;
  for (const name of preserved) {
    const src = join(realAgentDir, name);
    const dest = join(isolatedAgentDir, name);
    if (existsSync(src) && !existsSync(dest)) {
      symlinkSync(src, dest);
    }
  }

  return { realAgentDir, isolatedAgentDir };
}
