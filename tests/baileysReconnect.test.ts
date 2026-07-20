import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Audit M5: the Baileys connection.update / messages.upsert handlers are wired
// per-socket in connect(), but a torn-down socket can still emit a late `close`
// after it has been replaced. Without a socket-identity guard that stale event
// would flip `connected`/schedule a reconnect that ends the healthy current
// socket. This file mocks @whiskeysockets/baileys just enough to drive
// connect() twice and fire events on the OLD socket, proving they are ignored.
//
// config.ts validates env at import time.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

type FakeSock = {
  ev: EventEmitter;
  user: { id: string };
  end: () => void;
  ended: boolean;
  groupFetchAllParticipating: () => Promise<Record<string, unknown>>;
};

/**
 * Mocks the baileys module and returns the created-socket list + the adapter.
 * Each makeWASocket() call pushes a fresh fake socket whose `.ev` is a real
 * EventEmitter we can drive.
 */
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
        groupFetchAllParticipating: async () => ({}), // backfillRoster is fire-and-forget on open
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
  const { BaileysAdapter } = await import('../src/platforms/whatsapp/baileysAdapter.js');
  return {
    adapter: new BaileysAdapter() as unknown as {
      start: () => Promise<void>;
      isConnected: () => boolean;
    } & Record<string, unknown>,
    sockets,
  };
}

function emitUpdate(sock: FakeSock, update: Record<string, unknown>): void {
  sock.ev.emit('connection.update', update);
}

test('baileys reconnect: a stale (replaced) socket’s late `close` is ignored — it can’t flip `connected` on the healthy current socket (audit M5)', async (t) => {
  const { adapter, sockets } = await loadAdapter(t);

  await adapter.start(); // creates socket A, this.sock = A
  // Force a second connect() so socket B replaces A (as a reconnect would).
  await (adapter as unknown as { connect: () => Promise<void> }).connect();
  assert.equal(sockets.length, 2, 'two sockets were created (A replaced by B)');
  const [sockA, sockB] = sockets;
  assert.equal(sockA.ended, true, 'the previous socket A was torn down when B replaced it');

  // B opens and is healthy.
  emitUpdate(sockB, { connection: 'open' });
  assert.equal(adapter.isConnected(), true, 'the current socket B is connected');

  // A late `close` arrives from the STALE socket A. It must be ignored.
  emitUpdate(sockA, { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
  assert.equal(
    adapter.isConnected(),
    true,
    'a stale socket’s close must NOT mark the adapter disconnected while the current socket is healthy',
  );

  // Sanity: a `close` from the CURRENT socket B still works (loggedOut so no
  // reconnect side-effects), proving the guard targets identity, not all closes.
  emitUpdate(sockB, { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(adapter.isConnected(), false, 'the current socket’s own close still marks it disconnected');
});
