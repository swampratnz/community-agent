import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment before
// importing anything that (transitively) loads it, matching router.test.ts.
// Nothing here touches the DB: these tests only inspect the pre-turn chain's
// SHAPE (names + order), never run a message through it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const { PRE_TURN_SPINE, registerPreTurnIntercept } = await import('../src/routerIntercepts.js');
const { Router, makeRouterDeps } = await import('../src/router.js');

/** The five community shortcuts/commands router.ts registers, in their long-standing evaluation order. */
const COMMUNITY_INTERCEPTS = [
  'ack-shortcut',
  'knowledge-shortcut',
  'whatsapp-text-commands',
  'repeat-question-shortcut',
  'repeat-max-turns-shortcut',
];

const makeRouter = () =>
  new Router(
    makeRouterDeps({
      runTurn: async () => {
        throw new Error('these tests never run a turn');
      },
    }),
  );

test('SECURITY: PRE_TURN_SPINE is frozen and lists the security-ordered pre-turn steps in exactly the audited order', () => {
  assert.ok(Object.isFrozen(PRE_TURN_SPINE), 'the spine must be frozen — non-reorderable at runtime');
  assert.deepEqual(
    [...PRE_TURN_SPINE],
    [
      'block-list',
      'role-resolution',
      'gated-guest',
      'record-inbound',
      'confirm-intercept',
      'escalation-confirm',
      'addressed-gate',
      'pause',
      'rate-limit',
      'daily-budget',
      'auto-answer-reserve',
      'memory-barrier',
      'auto-answer-thread',
    ],
    'the security spine order is load-bearing (docs/SECURITY.md) — a reorder here is a security regression, not a refactor',
  );
});

test('SECURITY: the router pre-turn chain starts with the whole spine, then the community intercepts in their shipped order', () => {
  const names = makeRouter().preTurnChainNames();
  assert.deepEqual(names.slice(0, PRE_TURN_SPINE.length), [...PRE_TURN_SPINE]);
  assert.deepEqual(names.slice(PRE_TURN_SPINE.length), COMMUNITY_INTERCEPTS);
});

test('SECURITY: a module-registered intercept can only slot into the post-spine region — never before or among the spine', () => {
  // Inert probe: 'continue' and no side effects, so later tests in this file
  // (and this process) are unaffected by it staying registered.
  registerPreTurnIntercept({ name: 'test-probe', run: async () => 'continue' });
  const names = makeRouter().preTurnChainNames();
  assert.deepEqual(
    names.slice(0, PRE_TURN_SPINE.length),
    [...PRE_TURN_SPINE],
    'registration must never displace or interleave with the spine',
  );
  assert.equal(
    names.indexOf('test-probe'),
    names.length - 1,
    'registration is append-only, after the spine region',
  );
});

test('SECURITY: registering an intercept that reuses a spine step name (or a taken name) is rejected', () => {
  assert.throws(
    () => registerPreTurnIntercept({ name: 'confirm-intercept', run: async () => 'continue' }),
    /security-spine/,
  );
  assert.throws(
    () => registerPreTurnIntercept({ name: 'test-probe', run: async () => 'continue' }),
    /already registered/,
  );
});
