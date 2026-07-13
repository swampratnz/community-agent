import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Knowledge link-rot check (issue #448). Classification/SSRF-guard tests are
// pure (fetch + DNS lookup always injected, never real network); the
// persistence tests are DB-backed (skip cleanly without DATABASE_URL, per
// CLAUDE.md).
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { saveKnowledge, listKnowledge } = await import('../src/storage/repository.js');
const { shouldRunKnowledgeLinkCheck, classifySourceUrl, runKnowledgeLinkCheck, isDisallowedIp } =
  await import('../src/context/linkCheck.js');

const RUN = `t${Date.now()}${Math.floor(Math.random() * 1e6)}`;

after(async () => {
  await closeDb();
});

/** A minimal fetch-Response stand-in — just enough of the shape classifySourceUrl reads. */
function fakeResponse(status: number, opts: { location?: string } = {}): unknown {
  return {
    status,
    headers: { get: (name: string) => (name === 'location' ? (opts.location ?? null) : null) },
    body: null,
  };
}

// --- isDisallowedIp (pure) --------------------------------------------------

test('SECURITY: isDisallowedIp blocks every loopback/private/link-local/cloud-metadata range the SSRF guard is required to deny (IPv4 + IPv6), and never blocks an ordinary public address', () => {
  const blockedV4 = [
    '127.0.0.1',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.0.1',
    '169.254.169.254', // the common cloud metadata address
  ];
  for (const ip of blockedV4) assert.equal(isDisallowedIp(ip, 4), true, `${ip} must be blocked`);

  const publicV4 = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '11.0.0.1'];
  for (const ip of publicV4) assert.equal(isDisallowedIp(ip, 4), false, `${ip} must NOT be blocked`);

  const blockedV6 = [
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'febf:ffff::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ];
  for (const ip of blockedV6) assert.equal(isDisallowedIp(ip, 6), true, `${ip} must be blocked`);

  const publicV6 = ['2001:4860:4860::8888', 'fec0::1', '2606:4700:4700::1111'];
  for (const ip of publicV6) assert.equal(isDisallowedIp(ip, 6), false, `${ip} must NOT be blocked`);
});

// --- classifySourceUrl (pure — fetch/lookup always injected) ---------------

test('shouldRunKnowledgeLinkCheck: first run always, then only after ~a week (mirroring docs-ingest cadence)', () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldRunKnowledgeLinkCheck(null, now), true);
  assert.equal(
    shouldRunKnowledgeLinkCheck(new Date(now - 2 * 24 * 3_600_000), now),
    false,
    '2 days ago → skip',
  );
  assert.equal(
    shouldRunKnowledgeLinkCheck(new Date(now - 7 * 24 * 3_600_000), now),
    true,
    '7 days ago → run',
  );
});

test('classifySourceUrl: a 2xx response classifies as reachable', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const fetchImpl = async () => fakeResponse(200);
  const outcome = await classifySourceUrl('https://example.com/page', {
    lookup,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(outcome, 'reachable');
});

test('classifySourceUrl: a 4xx/5xx response classifies as unreachable', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  for (const status of [404, 410, 500, 503]) {
    const fetchImpl = async () => fakeResponse(status);
    const outcome = await classifySourceUrl('https://example.com/page', {
      lookup,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assert.equal(outcome, 'unreachable', `status ${status} must classify as unreachable`);
  }
});

test('classifySourceUrl: a DNS lookup failure (e.g. NXDOMAIN) classifies as unreachable, not refused — a real reachability signal, distinct from an SSRF-guard block', async () => {
  const lookup = async () => {
    throw new Error('ENOTFOUND');
  };
  const fetchImpl = async () => {
    throw new Error('unreachable: fetch must never be called after a DNS failure');
  };
  const outcome = await classifySourceUrl('https://this-domain-does-not-exist.invalid/page', {
    lookup,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(outcome, 'unreachable');
});

test('classifySourceUrl: a network error/timeout on the request itself classifies as unreachable', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const fetchImpl = async () => {
    throw new Error('fetch failed');
  };
  const outcome = await classifySourceUrl('https://example.com/page', {
    lookup,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(outcome, 'unreachable');
});

test('classifySourceUrl: a malformed sourceUrl classifies as unreachable without any lookup or fetch attempt', async () => {
  let lookupCalls = 0;
  const lookup = async () => {
    lookupCalls++;
    return [{ address: '1.1.1.1', family: 4 }];
  };
  const outcome = await classifySourceUrl('not a url', { lookup });
  assert.equal(outcome, 'unreachable');
  assert.equal(lookupCalls, 0);
});

test('classifySourceUrl: follows a redirect chain (re-guarding each hop) to a final 2xx — reachable', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let calls = 0;
  const fetchImpl = async (url: URL) => {
    calls++;
    if (url.href === 'https://example.com/old')
      return fakeResponse(301, { location: 'https://example.com/new' });
    return fakeResponse(200);
  };
  const outcome = await classifySourceUrl('https://example.com/old', {
    lookup,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(outcome, 'reachable');
  assert.equal(calls, 2, 'both hops are requested');
});

test('classifySourceUrl: a redirect chain that never resolves within the hop cap classifies as unreachable, not an infinite loop', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let calls = 0;
  const fetchImpl = async (url: URL) => {
    calls++;
    const n = Number(url.searchParams.get('n') ?? '0');
    return fakeResponse(302, { location: `https://example.com/loop?n=${n + 1}` });
  };
  const outcome = await classifySourceUrl('https://example.com/loop?n=0', {
    lookup,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(outcome, 'unreachable');
  assert.ok(calls <= 7, 'the redirect chain is bounded by the hop cap, not followed indefinitely');
});

test('classifySourceUrl: HEAD 405 (method not allowed) falls back to a ranged, body-less GET — the fallback response wins classification', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const methods: string[] = [];
  const fetchImpl = async (_url: URL, init: { method: string; headers: Record<string, string> }) => {
    methods.push(init.method);
    if (init.method === 'HEAD') return fakeResponse(405);
    assert.equal(init.headers['range'], 'bytes=0-0', 'the GET fallback never downloads a full body');
    return fakeResponse(200);
  };
  const outcome = await classifySourceUrl('https://example.com/head-unsupported', {
    lookup,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(outcome, 'reachable');
  assert.deepEqual(methods, ['HEAD', 'GET']);
});

// --- SSRF guard (SECURITY) ---------------------------------------------------

test('SECURITY: classifySourceUrl refuses a non-https sourceUrl — no DNS lookup and no outbound request', async () => {
  let lookupCalls = 0;
  let fetchCalls = 0;
  const lookup = async () => {
    lookupCalls++;
    return [{ address: '8.8.8.8', family: 4 }];
  };
  const fetchImpl = async () => {
    fetchCalls++;
    return fakeResponse(200);
  };
  const outcome = await classifySourceUrl('http://example.com/page', {
    lookup,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(outcome, 'refused');
  assert.equal(lookupCalls, 0, 'the protocol check happens before any DNS lookup');
  assert.equal(fetchCalls, 0, 'no outbound request is ever issued for a refused target');
});

test('SECURITY: classifySourceUrl refuses a sourceUrl whose hostname resolves to a private/loopback/link-local/cloud-metadata address — no outbound HTTP request is ever issued', async () => {
  let fetchCalls = 0;
  for (const [ip, family] of [
    ['169.254.169.254', 4],
    ['127.0.0.1', 4],
    ['10.1.2.3', 4],
    ['::1', 6],
    ['fd00::1', 6],
  ] as const) {
    const lookup = async () => [{ address: ip, family }];
    const fetchImpl = async () => {
      fetchCalls++;
      return fakeResponse(200);
    };
    const outcome = await classifySourceUrl('https://looks-public.example.com/probe', {
      lookup,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    assert.equal(outcome, 'refused', `a hostname resolving to ${ip} must be refused`);
  }
  assert.equal(
    fetchCalls,
    0,
    'the SSRF guard blocks every one of these targets before any request is issued',
  );
});

test('SECURITY: classifySourceUrl re-applies the SSRF guard to a redirect hop — a public host redirecting to an internal address is refused, and the internal host is never requested', async () => {
  let fetchCalls = 0;
  const lookup = async (hostname: string) =>
    hostname === 'public.example.com'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }];
  const fetchImpl = async (url: URL) => {
    fetchCalls++;
    if (url.hostname === 'public.example.com') {
      return fakeResponse(302, { location: 'https://internal.example.com/secret' });
    }
    throw new Error('unreachable: the internal redirect target must never actually be requested');
  };
  const outcome = await classifySourceUrl('https://public.example.com/redirector', {
    lookup,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  assert.equal(outcome, 'refused');
  assert.equal(fetchCalls, 1, 'only the first (public) hop is ever requested');
});

// --- runKnowledgeLinkCheck (DB-backed) --------------------------------------

test(
  'runKnowledgeLinkCheck: a 404 sourceUrl is flagged source_unreachable=true with source_checked_at set; a 200 one is flagged false',
  { skip },
  async () => {
    const deadUrl = 'https://dead.example.com/page';
    const liveUrl = 'https://live.example.com/page';
    const { id: deadId } = await saveKnowledge({
      title: `${RUN} dead`,
      content: 'dead citation',
      scope: `${RUN}-scope`,
      sourceUrl: deadUrl,
    });
    const { id: liveId } = await saveKnowledge({
      title: `${RUN} live`,
      content: 'live citation',
      scope: `${RUN}-scope`,
      sourceUrl: liveUrl,
    });

    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const fetchImpl = async (url: URL) => (url.href === deadUrl ? fakeResponse(404) : fakeResponse(200));

    const result = await runKnowledgeLinkCheck({ lookup, fetchImpl: fetchImpl as unknown as typeof fetch });
    assert.ok(result.candidates >= 2);

    const { rows } = await pool.query(
      `SELECT id, source_unreachable, source_checked_at FROM knowledge WHERE id = ANY($1)`,
      [[deadId, liveId]],
    );
    const dead = rows.find((r) => Number(r.id) === deadId);
    const live = rows.find((r) => Number(r.id) === liveId);
    assert.equal(dead.source_unreachable, true);
    assert.ok(dead.source_checked_at);
    assert.equal(live.source_unreachable, false);
    assert.ok(live.source_checked_at);

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[deadId, liveId]]);
  },
);

test(
  'SECURITY: runKnowledgeLinkCheck never persists a result for an entry the SSRF guard refuses — source_unreachable and source_checked_at stay untouched (no outbound request, no surfaced reachability result)',
  { skip },
  async () => {
    const internalUrl = 'https://internal.example.invalid/probe';
    const { id } = await saveKnowledge({
      title: `${RUN} internal-probe`,
      content: 'an admin-set internal-looking source url',
      scope: `${RUN}-scope`,
      sourceUrl: internalUrl,
    });

    const lookup = async (hostname: string) =>
      hostname === 'internal.example.invalid'
        ? [{ address: '169.254.169.254', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];
    const fetchImpl = async () => fakeResponse(200);

    const result = await runKnowledgeLinkCheck({ lookup, fetchImpl: fetchImpl as unknown as typeof fetch });
    assert.ok(result.refused >= 1);

    const { rows } = await pool.query(
      `SELECT source_unreachable, source_checked_at FROM knowledge WHERE id = $1`,
      [id],
    );
    assert.equal(
      rows[0].source_unreachable,
      null,
      'a refused entry must never be stamped reachable/unreachable',
    );
    assert.equal(
      rows[0].source_checked_at,
      null,
      'a refused entry must never get a checked_at timestamp either',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  },
);

test(
  'SECURITY: the response body of a checked URL is never read (.text()/.json()) by the checker, and no marker from it ever reaches the run result or the persisted row',
  { skip },
  async () => {
    const marker = 'SECRET_BODY_MARKER_9f3a7c';
    const url = 'https://body-marker.example.com/page';
    const { id } = await saveKnowledge({
      title: `${RUN} body-marker`,
      content: 'original content, unrelated to any response body',
      scope: `${RUN}-scope`,
      sourceUrl: url,
    });

    let bodyReadCount = 0;
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const fetchImpl = async () => ({
      status: 200,
      headers: { get: () => null },
      body: null,
      text: async () => {
        bodyReadCount++;
        return marker;
      },
      json: async () => {
        bodyReadCount++;
        return { marker };
      },
    });

    const result = await runKnowledgeLinkCheck({ lookup, fetchImpl: fetchImpl as unknown as typeof fetch });
    assert.equal(bodyReadCount, 0, 'the checker must never call .text()/.json() on the response');
    assert.ok(
      !JSON.stringify(result).includes(marker),
      'the run result must never carry the response body/marker',
    );

    const { rows } = await pool.query(
      `SELECT content, source_unreachable, source_checked_at FROM knowledge WHERE id = $1`,
      [id],
    );
    assert.equal(
      rows[0].content,
      'original content, unrelated to any response body',
      'the entry content is never overwritten with response data',
    );
    assert.equal(rows[0].source_unreachable, false);
    assert.ok(!JSON.stringify(rows[0]).includes(marker));

    await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  },
);

test(
  'repository: listKnowledge({ sourceUnreachable: true }) returns exactly the flagged subset',
  { skip },
  async () => {
    const scope = `${RUN}-source-unreachable-scope`;
    const { id: flaggedId } = await saveKnowledge({
      title: 'flagged-entry',
      content: 'this one is flagged unreachable',
      scope,
      sourceUrl: 'https://flagged.example.com/page',
    });
    const { id: healthyId } = await saveKnowledge({
      title: 'healthy-entry',
      content: 'this one is healthy',
      scope,
      sourceUrl: 'https://healthy.example.com/page',
    });
    const { id: uncheckedId } = await saveKnowledge({
      title: 'unchecked-entry',
      content: 'this one was never checked',
      scope,
      sourceUrl: 'https://unchecked.example.com/page',
    });

    await pool.query(
      `UPDATE knowledge SET source_unreachable = true, source_checked_at = now() WHERE id = $1`,
      [flaggedId],
    );
    await pool.query(
      `UPDATE knowledge SET source_unreachable = false, source_checked_at = now() WHERE id = $1`,
      [healthyId],
    );

    const entries = await listKnowledge({ scope, sourceUnreachable: true });
    assert.deepEqual(
      entries.map((e) => e.id).sort(),
      [flaggedId],
      'only the flagged entry is returned — the healthy and never-checked entries are excluded',
    );

    await pool.query(`DELETE FROM knowledge WHERE id = ANY($1)`, [[flaggedId, healthyId, uncheckedId]]);
  },
);
