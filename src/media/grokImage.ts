import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
 * Pure: did the sandbox FAIL to contain the probe read? True only if grok's
 * output actually contains the sentinel token — i.e. a read of a deny-listed
 * path succeeded. Exported for a unit test (CI has no grok binary to exercise
 * the real sandbox).
 */
export function sandboxBreached(stdout: string, token: string): boolean {
  return stdout.includes(token);
}

/** The custom grok sandbox profile the bot writes to `~/.grok/sandbox.toml` and passes to `--sandbox`. */
export const SANDBOX_PROFILE = 'imagegen';

/**
 * Absolute paths grok must be KERNEL-denied from reading during image gen: the
 * bot's `.env` and WhatsApp auth dir (its on-disk secrets), plus a dedicated
 * probe path the self-check uses. Derived from the bot's OWN cwd + config so
 * the deny policy travels with the deployment. `authDir` may be relative
 * (config default `./whatsapp-auth`) — resolve it against cwd.
 */
export function sandboxDenyPaths(
  cwd: string,
  authDir: string,
): { envPath: string; authPath: string; probePath: string } {
  return {
    envPath: join(cwd, '.env'),
    authPath: isAbsolute(authDir) ? authDir : join(cwd, authDir),
    probePath: join(cwd, '.grok-image-sandbox-probe'),
  };
}

/**
 * The `~/.grok/sandbox.toml` body defining the `imagegen` deny profile. Pure so
 * a test can pin that the secrets are in the kernel-deny list.
 *
 * The `deny` list is bubblewrap-enforced on Linux (read AND write/rename, and
 * it closes the `mv secret x && cat x` bypass), and grok REFUSES TO START if
 * bubblewrap is missing or a deny path can't be bound — i.e. it fails closed
 * rather than run with the secrets exposed. `restrict_network` blocks
 * child-process network (no exfil); `extends = "strict"` is the base. NB the
 * built-in `strict` profile's own landlock read-restriction does NOT actually
 * block reads on the host (verified) — the bubblewrap `deny` list is what
 * enforces, which is why we probe a *denied* path below rather than trust
 * `strict` alone.
 */
export function buildSandboxToml(denyPaths: readonly string[]): string {
  const deny = denyPaths.map((p) => `  ${JSON.stringify(p)},`).join('\n');
  return `# Managed by community-agent (src/media/grokImage.ts) — do not edit by hand.
# Kernel-enforced (bubblewrap) deny-list that contains grok during image
# generation. grok refuses to start if bubblewrap is missing or a deny path
# can't be bound, so image gen fails closed rather than exposing these paths.
[profiles.${SANDBOX_PROFILE}]
extends = "strict"
restrict_network = true
deny = [
${deny}
]
`;
}

/**
 * Prepare + self-verify the sandbox ONCE per process, before the first
 * generation. Writes the `imagegen` deny profile, then plants a random token in
 * a DENY-LISTED path and confirms a sandboxed grok cannot read it back:
 *   - token returned  → the kernel deny-list is NOT enforcing → refuse to
 *     generate (fail CLOSED; the cached rejection keeps image gen off until the
 *     service restarts).
 *   - cancelled / errored / absent → enforced (or grok refused to start, itself
 *     fail-closed) → proceed. Only a positive leak disables, so a flaky probe
 *     never falsely disables a working sandbox. Cached: only the first
 *     generation pays the extra grok call.
 */
let sandboxReady: Promise<void> | null = null;
function ensureSandboxReady(): Promise<void> {
  if (!sandboxReady) {
    sandboxReady = (async () => {
      const home = process.env.HOME;
      if (!home) throw new Error('HOME is not set; cannot configure the grok image sandbox.');
      const { envPath, authPath, probePath } = sandboxDenyPaths(process.cwd(), config.whatsapp.authDir);
      await writeFile(
        join(home, '.grok', 'sandbox.toml'),
        buildSandboxToml([envPath, authPath, probePath]),
        'utf8',
      );

      const token = `GROK_SANDBOX_PROBE_${randomUUID()}`;
      const cwd = await mkdtemp(join(tmpdir(), 'grokprobe-'));
      try {
        await writeFile(probePath, token, 'utf8');
        const stdout = await runGrok(
          `Read the file ${probePath} and reply with its exact contents.`,
          cwd,
        ).catch(() => '');
        if (sandboxBreached(stdout, token)) {
          logger.error('grok sandbox deny-list did not block a denied read — disabling image generation');
          throw new Error(
            'grok sandbox self-check failed: a deny-listed path was readable (is bubblewrap installed?). ' +
              'Image generation is disabled until this is fixed (see docs/SECURITY.md §8).',
          );
        }
      } finally {
        await rm(probePath, { force: true }).catch(() => {});
        await rm(cwd, { recursive: true, force: true }).catch(() => {});
      }
    })();
  }
  return sandboxReady;
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
 * SECURITY POSTURE (see docs/SECURITY.md) — host-verified controls:
 *  - `--sandbox imagegen`: a custom profile (written by `ensureSandboxReady`)
 *    whose bubblewrap-enforced `deny` list KERNEL-blocks reads of the bot's
 *    secrets (`.env`, WhatsApp auth), and whose `restrict_network` blocks
 *    child-process network (no exfil). grok REFUSES TO START if bubblewrap is
 *    missing or a deny path can't be bound, so it fails closed. Verified on the
 *    host: a read of `.env` under this profile is kernel-denied (`read_file`
 *    tool error) while `/imagine` still generates. NB the built-in `strict`
 *    profile's own landlock read-restriction does NOT actually block reads here
 *    — reads succeed everywhere under it — which is why we use the bubblewrap
 *    `deny` list, not `strict` alone.
 *  - NO `--always-approve`: headless grok then CANCELS approval-gated tool
 *    calls (shell / file write) instead of running them — verified: a prompt
 *    ordering the shell to write a file returned stopReason "Cancelled". (Read
 *    tools ARE auto-approved, which is why the kernel deny-list, not the absence
 *    of --always-approve alone, is the containment. A `--tools` allowlist can't
 *    be used — the image tool isn't `--tools`-selectable — and a `--deny` tool
 *    name that doesn't match grok's internal id fails OPEN.)
 *  - `ensureSandboxReady()` self-checks the deny list ONCE per process before
 *    the first generation: it plants a token in a DENY-LISTED path and confirms
 *    a sandboxed grok can't read it, failing CLOSED (image gen disabled) if the
 *    kernel deny ever stops enforcing.
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
    // Write the deny profile + fail closed if the kernel sandbox isn't containing.
    await ensureSandboxReady();
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
 *  - `--sandbox imagegen`: our custom profile (written by `ensureSandboxReady`),
 *    whose bubblewrap-enforced `deny` list kernel-blocks reads of the bot's
 *    secrets (`.env`, WhatsApp auth) and whose `restrict_network` blocks
 *    child-process network. Verified on the host that a read of `.env` is
 *    kernel-denied while `/imagine` still generates. (The built-in `strict`
 *    profile's landlock read-restriction does NOT actually block reads here — so
 *    we can't rely on it; and a `--tools`/`--deny` tool filter fails OPEN.)
 *  - `--disable-web-search` removes the web tools; `--output-format json` gives
 *    us the session id; the prompt is `/imagine <description>` — grok's image skill.
 */
export function buildGrokArgs(instruction: string): string[] {
  return ['--sandbox', SANDBOX_PROFILE, '--output-format', 'json', '--disable-web-search', '-p', instruction];
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
