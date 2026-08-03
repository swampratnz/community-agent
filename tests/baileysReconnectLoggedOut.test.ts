import { test } from 'node:test';
import assert from 'node:assert/strict';
// The adapters take their community text pack as a required constructor
// parameter now (agent-base plan item 6) — production hands it over in
// src/module/platforms/factories.ts, so these constructions pass the same pack.
import { BAILEYS_TEXT_PACK } from '../src/module/platforms/textPacks.js';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
import { EventEmitter } from 'node:events';

// A logged-out (401) close must NEVER schedule a reconnect. This is the case
// the 2026-07-29 405 outage was NOT: 401 means WhatsApp revoked the linked
// device, and retrying a revoked session is exactly the behaviour that puts
// the account at risk (docs/SECURITY.md's Baileys ToS exposure). It needs
// `npm run whatsapp:link`, and crucially the attempt CAP must not be what
// stops it — the 401 branch must refuse to retry from the very first close.
//
// Original 405 context, for contrast. WhatsApp began refusing
// the connection with `statusCode: 405, loggedOut: false` and the adapter,
// having no ceiling, retried 73 times over ~6 hours at the 5-minute backoff
// cap. A 405 is a REFUSAL rather than a network blip, and docs/SECURITY.md
// treats Baileys ToS/ban exposure as live, so the loop is now bounded by
// WHATSAPP_MAX_RECONNECT_ATTEMPTS.
//
// ONE test per file, deliberately: `t.mock.module` only affects SUBSEQUENT
// imports, so a second test in the same file would get this test's disposed
// mock out of the module cache and build no sockets at all. Its sibling
// tests/baileysReconnectCap.test.ts exists for the same reason.
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
  const { BaileysAdapter } = await import('@swampratnz/agent-base/platforms/whatsapp/baileysAdapter.js');
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

test('SECURITY: a logged-out (401) close never schedules a reconnect, so a revoked session is not retried against WhatsApp', async (t) => {
  const { adapter, sockets } = await loadAdapter(t);
  await adapter.start();
  assert.equal(sockets.length, 1);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  emitUpdate(sockets[0], {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } },
  });
  // Far beyond any backoff the bounded-retry path would have scheduled.
  t.mock.timers.tick(60 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    sockets.length,
    1,
    'a loggedOut close must build no further socket — not even the first retry',
  );
  assert.equal(adapter.isConnected(), false);
});
