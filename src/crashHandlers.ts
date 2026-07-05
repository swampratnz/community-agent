import type { Logger } from './logger.js';

/**
 * Install global handlers for the two error classes that otherwise escape the
 * per-call `.catch()`/try-blocks and can crash the process with no logged
 * reason:
 *
 *   - `unhandledRejection`: a promise rejected with no `.catch()`. Almost
 *     always a bug worth fixing, but not necessarily fatal — we log it at
 *     ERROR (so it's visible in journald) and keep the bot serving.
 *   - `uncaughtException`: a synchronous throw that reached the top of the
 *     stack. The process state is now undefined, so the safe move is to log at
 *     ERROR and exit non-zero; systemd's `Restart=on-failure` then brings the
 *     bot back cleanly. Attempting graceful async shutdown from a corrupt state
 *     is riskier than a fast restart.
 *
 * `onFatal` is injectable so tests can assert the exit without killing the
 * runner; production uses `process.exit`.
 */
export function installCrashHandlers(
  log: Logger,
  onFatal: (code: number) => void = (code) => process.exit(code),
): void {
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection (logged; process kept alive)');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err }, 'Uncaught exception — exiting for a clean restart');
    onFatal(1);
  });
}
