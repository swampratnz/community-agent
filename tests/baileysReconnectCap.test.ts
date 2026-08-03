import { test } from 'node:test';
import assert from 'node:assert/strict';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/module/platforms/factories.ts, so these constructions pass the same pack.
import { BAILEYS_TEXT_PACK } from '../src/module/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/module/strings/notices.js';
import { EventEmitter } from 'node:events';

// Bounded WhatsApp reconnect — the 2026-07-29 outage. WhatsApp began refusing
// the connection with `statusCode: 405, loggedOut: false` and the adapter,
// having no ceiling, retried 73 times over ~6 hours at the 5-minute backoff
// cap. A 405 is a REFUSAL rather than a network blip, and docs/SECURITY.md
// treats Baileys ToS/ban exposure as live, so the loop is now bounded by
// WHATSAPP_MAX_RECONNECT_ATTEMPTS.
//
// ONE test per file, deliberately: `t.mock.module` only affects SUBSEQUENT
// imports, so a second test in the same file would get this test's disposed
// mock out of the module cache and build no sockets at all. Its sibling
// tests/baileysReconnectLoggedOut.test.ts exists for the same reason.
//
// config.ts validates env at import time.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
// Small cap keeps the test fast and explicit; production defaults to 20
// (~1 h of backoff). See config.ts for why it is bounded at all.
process.env.WHATSAPP_MAX_RECONNECT_ATTEMPTS ??= '3';
const MAX_ATTEMPTS = 3;

type FakeSock = {
  ev: EventEmitter;
  user: { id: string };
  end: () => void;
  ended: boolean;
  groupFetchAllParticipating: () => Promise<Record<string, unknown>>;
};

async function loadAdapter(t: { mock: { module: (specifier: string, opts: unknown) => void } }): Promise<{
  adapter: { start: () => Promise<void>; isConnected: () => boolean } & Record<string, unknown>;
  sockets: FakeSock[];
}> {
  const sockets: FakeSock[] = [];
  t.mock.module('@whiskeysockets/baileys', {
    defaultExport: () => {
      const sock: FakeSock = {
        ev: new EventEmitter(),
        user: { id: `11122233344${sockets.length}@s.whatsapp.net` },
        ended: false,
        end() {
          this.ended = true;
        },
        groupFetchAllParticipating: async () => ({}),
      };
      sockets.push(sock);
      return sock;
    },
    namedExports: {
      DisconnectReason: { loggedOut: 401 },
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
      useMultiFileAuthState: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
      downloadMediaMessage: async () => Buffer.from(''),
      proto: {},
    },
  });
  const { BaileysAdapter } = await import('../src/base/platforms/whatsapp/baileysAdapter.js');
  return {
    adapter: new BaileysAdapter(BAILEYS_TEXT_PACK) as unknown as {
      start: () => Promise<void>;
      isConnected: () => boolean;
    } & Record<string, unknown>,
    sockets,
  };
}

function emitUpdate(sock: FakeSock, update: Record<string, unknown>): void {
  sock.ev.emit('connection.update', update);
}

test('baileys reconnect is BOUNDED: it stops at the configured cap, stays stopped, and a successful connect restores the full budget (2026-07-29 405 outage)', async (t) => {
  const { adapter, sockets } = await loadAdapter(t);
  await adapter.start();
  assert.equal(sockets.length, 1, 'start() built the first socket');

  // Fake timers only AFTER startup: connect() is async and mocking setTimeout
  // before the first socket exists stalls it.
  t.mock.timers.enable({ apis: ['setTimeout'] });

  /** Close the newest socket with a non-loggedOut status, then fire its timer. */
  const failAndAdvance = async () => {
    emitUpdate(sockets[sockets.length - 1], {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 405 } } },
    });
    t.mock.timers.tick(10 * 60_000); // beyond MAX_RECONNECT_DELAY_MS (5 min)
    await new Promise((resolve) => setImmediate(resolve)); // let connect() settle
  };

  // --- every attempt inside the budget reconnects -------------------------
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    await failAndAdvance();
    assert.equal(sockets.length, i + 2, `attempt ${i + 1} built a replacement socket`);
  }

  // --- the attempt past the cap gives up ----------------------------------
  await failAndAdvance();
  assert.equal(
    sockets.length,
    MAX_ATTEMPTS + 1,
    'once the budget is exhausted the adapter gives up instead of building another socket',
  );

  // --- and stays given up; no zombie timer revives the loop ---------------
  t.mock.timers.tick(60 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, MAX_ATTEMPTS + 1, 'no pending timer resurrected the retry loop');
  assert.equal(
    adapter.isConnected(),
    false,
    'it reports disconnected, so health.ts’s sustained-disconnect alert keeps notifying super admins',
  );

  // --- a successful open resets the budget --------------------------------
  // Drive one more connect by hand (the loop has given up) and open it.
  await (adapter as unknown as { connect: () => Promise<void> }).connect();
  const revived = sockets.length;
  emitUpdate(sockets[sockets.length - 1], { connection: 'open' });
  assert.equal(adapter.isConnected(), true, 'reconnected');

  // The counter zeroed, so a fresh outage gets the FULL allowance again
  // rather than the (already exhausted) remainder.
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) await failAndAdvance();
  assert.equal(
    sockets.length,
    revived + MAX_ATTEMPTS,
    'a successful connection restored the whole budget for the next outage',
  );
});
