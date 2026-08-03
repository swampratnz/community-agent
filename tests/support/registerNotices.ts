import { registerNoticePack } from '@swampratnz/agent-base/strings/catalogue.js';
import { NOTICE_AXES, NOTICE_ENTRIES } from '../../src/module/strings/notices.js';

/**
 * The manifest's `notices` registration (src/module/agentModule.ts), for tests.
 *
 * No idempotency guard is needed: an ES module body runs exactly once per
 * process, and `node:test` runs each test FILE in its own process — so
 * importing this from several places in one suite registers once, exactly as
 * `createAgent` does in production. Same for every sibling helper here.
 */
registerNoticePack(NOTICE_AXES, NOTICE_ENTRIES);
