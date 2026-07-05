import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from '../src/logger.js';
import { installCrashHandlers } from '../src/crashHandlers.js';

// crashHandlers.ts only *type*-imports the logger (erased at runtime), so this
// file loads without touching config/env or a DB.

type Handler = (arg: unknown) => void;

function harness(t: { mock: { method: typeof import('node:test').mock.method } }) {
  const registered: Record<string, Handler> = {};
  t.mock.method(process, 'on', ((event: string, handler: Handler) => {
    registered[event] = handler;
    return process;
  }) as typeof process.on);
  const errors: Array<{ meta: unknown; msg: string }> = [];
  const log = { error: (meta: unknown, msg: string) => errors.push({ meta, msg }) } as unknown as Logger;
  let fatalCode: number | null = null;
  installCrashHandlers(log, (code) => {
    fatalCode = code;
  });
  return { registered, errors, getFatal: () => fatalCode };
}

test('installCrashHandlers registers both unhandledRejection and uncaughtException handlers', (t) => {
  const { registered } = harness(t);
  assert.ok(registered.unhandledRejection, 'unhandledRejection handler registered');
  assert.ok(registered.uncaughtException, 'uncaughtException handler registered');
});

test('unhandledRejection is logged at error level and does NOT exit the process', (t) => {
  const { registered, errors, getFatal } = harness(t);
  registered.unhandledRejection(new Error('boom'));
  assert.equal(errors.length, 1, 'the rejection is logged once');
  assert.match(errors[0].msg, /rejection/i);
  assert.equal(getFatal(), null, 'a rejection must not trigger a fatal exit — the bot keeps serving');
});

test('uncaughtException is logged at error level and exits non-zero for a clean restart', (t) => {
  const { registered, errors, getFatal } = harness(t);
  registered.uncaughtException(new Error('fatal boom'));
  assert.equal(errors.length, 1, 'the exception is logged once');
  assert.match(errors[0].msg, /uncaught/i);
  assert.equal(getFatal(), 1, 'an uncaught exception exits non-zero so systemd restarts it');
});
