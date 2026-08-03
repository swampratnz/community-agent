import { execFile } from 'node:child_process';

/**
 * Fixed argv for the CONFIRM-gated `redeploy_bot` tool (issue #101, the
 * chat-triggered half of the nightly redeploy in #50). The tool's input
 * schema is `{}` — there is no caller- or model-supplied value that could
 * ever reach this command; the unit name is supplied by the CALLER (the
 * community `redeploy_bot` def in agent/tools/superAdmin.ts names this
 * deployment's unit), never by anything at runtime. `sudo -n` never prompts
 * for a password (fails fast instead of hanging if the sudoers grant from
 * docs/DEPLOYMENT.md is missing); `systemctl start --no-block` returns as
 * soon as the job is queued rather than waiting for the unit to finish —
 * which matters because that unit eventually restarts the bot's own service,
 * i.e. the cgroup this very process (and the child it just spawned) runs in.
 * Blocking would mean racing that teardown instead of returning cleanly.
 * Starting the same unit the nightly timer uses means the flock inside
 * scripts/redeploy.sh rules out overlap between the two paths.
 */
export const REDEPLOY_COMMAND = 'sudo';
export function redeployArgs(unitName: string): readonly string[] {
  return ['-n', 'systemctl', 'start', '--no-block', unitName];
}

export type RedeployRunner = (command: string, args: readonly string[]) => Promise<void>;

const defaultRunner: RedeployRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args as string[], (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve();
    });
  });

/**
 * Start the redeploy unit named by the caller. `runner` is overridable only
 * for tests — there is no way to reach it from a tool call or message
 * content. Never hangs: a missing/misconfigured sudoers grant makes `sudo -n`
 * fail immediately, which this turns into a clear rejection rather than
 * leaving the CONFIRM flow waiting. The status message names the same unit,
 * with the `.service` suffix dropped the way `journalctl -u` is normally
 * typed — one source of truth for which unit was actually started.
 */
export async function triggerRedeploy(
  unitName: string,
  runner: RedeployRunner = defaultRunner,
): Promise<string> {
  try {
    await runner(REDEPLOY_COMMAND, redeployArgs(unitName));
    return `Redeploy queued. The bot will restart mid-deploy; track progress with \`journalctl -u ${unitName.replace(/\.service$/, '')}\`.`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not start the redeploy unit (${detail}). Check the sudoers grant documented in docs/DEPLOYMENT.md.`,
      { cause: err },
    );
  }
}
