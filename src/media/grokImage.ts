import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  /** Extension matching the sniffed bytes (grok saves JPEG regardless of any requested name). */
  ext: string;
}

/**
 * Sniff the real image type from magic bytes — never trust a filename/extension,
 * grok writes whatever the model produced (currently JPEG).
 */
export function sniffImageType(buf: Buffer): { mimeType: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  return null;
}

/**
 * Build the *minimal* environment the `grok` subprocess is allowed to see.
 *
 * SECURITY: grok is a third-party agentic CLI. It must NOT inherit the bot's
 * full `process.env` (that would hand it CLAUDE_CODE_OAUTH_TOKEN,
 * DISCORD_BOT_TOKEN, DATABASE_URL, WhatsApp/session secrets, …). It authenticates
 * from a file (`$HOME/.grok/auth.json`), not an env var, so a curated allowlist
 * of non-secret vars is sufficient — proven on the host with `env -i`.
 *
 * Exported so a test can pin that no bot secret ever passes through the
 * allowlist (issue #225).
 */
export function grokEnv(): NodeJS.ProcessEnv {
  const src = process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: src.PATH,
    HOME: src.HOME,
    TERM: 'dumb',
    LANG: src.LANG ?? 'C.UTF-8',
  };
  if (src.LC_ALL) env.LC_ALL = src.LC_ALL;
  if (src.USER) env.USER = src.USER;
  // grok's own non-secret config knobs (e.g. GROK_SANDBOX, XDG dirs) pass through.
  for (const [k, v] of Object.entries(src)) {
    if ((k.startsWith('GROK_') || k.startsWith('XDG_')) && v !== undefined) env[k] = v;
  }
  return env;
}

/** Root of grok's per-session storage, derived from the HOME we hand the subprocess. */
function grokSessionsRoot(): string {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME is not set; cannot locate the grok CLI login or output.');
  return join(home, '.grok', 'sessions');
}

/**
 * Generate an image with the Grok Build CLI.
 *
 * Image generation is grok's `/imagine` skill (which drives the built-in
 * `image_gen` tool). The old `--tools GenerateImage` allowlist no longer works:
 * that tool name was removed, and a `--tools` allowlist that references a
 * non-existent tool makes grok's agent build fail ("Requirements unsatisfied:
 * run_terminal_cmd"). `/imagine` needs the full default toolset, so the
 * lockdown is re-expressed WITHOUT an allowlist:
 *
 * SECURITY POSTURE (see docs/SECURITY.md) — two independent, host-verified controls:
 *  - `--sandbox strict`: KERNEL-enforced (landlock + seccomp on Linux) file and
 *    network confinement. The agent can read only the throwaway CWD, `~/.grok/`,
 *    and essential system paths (NOT the bot's home/config), can write only to
 *    CWD / `~/.grok/` / temp, and child-process network is blocked. This is the
 *    control that actually contains a prompt-injected `/imagine` description:
 *    verified on the host that a read of `/opt/community-agent/.env` is
 *    Cancelled and no secret escapes, while a legitimate generation still
 *    works (grok reads its own auth, calls the image API, writes the image).
 *  - NO `--always-approve`: headless grok then CANCELS approval-gated tool
 *    calls (shell / file write) instead of running them — verified: a prompt
 *    ordering the shell to write a file returned stopReason "Cancelled".
 *    (Read tools ARE auto-approved, which is exactly why the sandbox — not the
 *    absence of --always-approve alone — is the real containment. A `--tools`
 *    allowlist can't be used: the image tool isn't `--tools`-selectable, and a
 *    `--deny` name that doesn't match grok's internal tool id fails OPEN.)
 *  - The subprocess gets a minimal env (grokEnv()), never the bot's secrets.
 *  - The prompt is an argv element, never a shell string (no shell injection),
 *    passed as `/imagine <prompt>` — i.e. strictly as an image description.
 *
 * `image_gen` saves the result under grok's own session storage
 * (`$HOME/.grok/sessions/<enc-cwd>/<sessionId>/images/N.*`) — we can't name the
 * path. We run it in a throwaway cwd, read the session id back from
 * `--output-format json`, load the image, and delete the session directory.
 * Throws on timeout, non-zero exit, or if no recognisable image is produced.
 */
export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const cwd = await mkdtemp(join(tmpdir(), 'grokimg-'));
  // `/imagine` is grok's image-generation skill; the prompt is its description.
  const instruction = `/imagine ${prompt}`;
  let sessionDir: string | undefined;
  try {
    const stdout = await runGrok(instruction, cwd);
    const sessionId = parseSessionId(stdout);
    if (!sessionId) throw new Error('Grok returned no session id; cannot locate the image.');
    const located = await locateSessionImage(sessionId);
    if (!located) throw new Error('Grok did not produce an image file.');
    sessionDir = located.sessionDir;
    const data = await readFile(located.imagePath);
    if (data.length === 0) throw new Error('Grok produced an empty image file.');
    const kind = sniffImageType(data);
    if (!kind) throw new Error('Grok produced an unrecognised (non-image) file.');
    return { data, ...kind };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    if (sessionDir) await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Pull the session id out of grok's `--output-format json` stdout. Exported for tests. */
export function parseSessionId(stdout: string): string | null {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
  try {
    const parsed = JSON.parse(stdout) as { sessionId?: unknown };
    if (typeof parsed.sessionId === 'string' && uuid.test(parsed.sessionId)) return parsed.sessionId;
  } catch {
    // Fall through to a regex scan if stdout wasn't clean JSON.
  }
  const m = stdout.match(new RegExp(`"sessionId"\\s*:\\s*"(${uuid.source})"`));
  return m ? m[1] : null;
}

/**
 * Find the image grok saved for this session. The sessions root holds one
 * directory per (url-encoded) cwd; a fresh session id is unique across them and
 * holds exactly one images/ dir. Returns the newest image and the session
 * directory to clean up.
 */
async function locateSessionImage(
  sessionId: string,
): Promise<{ imagePath: string; sessionDir: string } | null> {
  const root = grokSessionsRoot();
  const cwdDirs = await readdir(root).catch(() => [] as string[]);
  for (const cwdDir of cwdDirs) {
    const sessionDir = join(root, cwdDir, sessionId);
    const imagesDir = join(sessionDir, 'images');
    const files = await readdir(imagesDir).catch(() => null);
    if (files && files.length > 0) {
      // Numbered per session (1.jpg, 2.jpg…); take the highest.
      const newest = files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)!;
      return { imagePath: join(imagesDir, newest), sessionDir };
    }
  }
  return null;
}

/**
 * The argv for the grok subprocess. Exported and kept pure so a test can assert
 * the security-critical flags never silently drift. Two independent controls,
 * both verified on the host (see the SECURITY POSTURE block above):
 *  - NO `--always-approve`. Without it, headless grok CANCELS approval-gated
 *    tool calls (e.g. shell / file write) instead of running them.
 *  - `--sandbox strict`: KERNEL-enforced (landlock + seccomp on Linux) FS +
 *    network confinement — reads limited to the throwaway CWD, `~/.grok/`, and
 *    essential system paths; writes to CWD/`~/.grok/`/temp; child-process
 *    network blocked. This is what actually stops an injected `/imagine`
 *    description from reading the bot's secrets (`.env`, `~/.grok/auth.json`)
 *    or exfiltrating — verified: a read of `/opt/community-agent/.env` is
 *    Cancelled. We rely on the sandbox rather than a `--tools`/`--deny` tool
 *    filter because the image tool is not `--tools`-selectable and a `--deny`
 *    tool name that doesn't match is a silent no-op (fails OPEN).
 *  - `--disable-web-search` removes the web tools; `--output-format json` gives
 *    us the session id; the prompt is `/imagine <description>` — grok's image skill.
 */
export function buildGrokArgs(instruction: string): string[] {
  return ['--sandbox', 'strict', '--output-format', 'json', '--disable-web-search', '-p', instruction];
}

/** Spawn grok headlessly, locked to the image tool, and resolve its stdout. */
function runGrok(instruction: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.imageGen.grokBin, buildGrokArgs(instruction), {
      cwd,
      env: grokEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config.imageGen.timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Grok image generation timed out after ${config.imageGen.timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(-400) }, 'grok image generation failed');
        reject(new Error(`Grok exited with code ${code}.`));
        return;
      }
      resolve(stdout);
    });
  });
}
