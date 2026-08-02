import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemberId, resolveWhatsappLid } from '../src/auth/memberId.js';

test('accepts a valid WhatsApp E.164 number and strips a leading +', () => {
  assert.equal(normalizeMemberId('whatsapp', '64273938855'), '64273938855');
  assert.equal(normalizeMemberId('whatsapp', '+64273938855'), '64273938855');
  assert.equal(normalizeMemberId('whatsapp', '  64273938855 '), '64273938855');
});

test('accepts a valid Discord snowflake', () => {
  assert.equal(normalizeMemberId('discord', '896672027275034646'), '896672027275034646');
});

test('rejects a WhatsApp number registered as Discord (issue #78 regression)', () => {
  assert.throws(
    () => normalizeMemberId('discord', '64273938855'),
    /doesn't look like a Discord user id.*platform: "whatsapp"/s,
  );
});

test('rejects a Discord snowflake registered as WhatsApp', () => {
  assert.throws(
    () => normalizeMemberId('whatsapp', '896672027275034646'),
    /doesn't look like a WhatsApp number.*platform: "discord"/s,
  );
});

test('SECURITY: an unregistered platform is refused — member-id validation fails closed now that Platform is an open string', () => {
  // Since agent-base plan item 9, normalizeMemberId dispatches over the
  // platform registry's per-adapter rules. A platform string nothing
  // registered must throw (naming the registered platforms), never fall
  // through to some default shape check — an id no platform vouches for
  // could otherwise be minted into an identity row that can never match a
  // real sender (the same principle as the LID bound below).
  assert.throws(
    () => normalizeMemberId('telegram', '64273938855'),
    /Unknown platform "telegram".*registered platforms: discord, whatsapp/s,
  );
});

test('rejects non-numeric ids', () => {
  assert.throws(() => normalizeMemberId('whatsapp', 'not-a-number'), /expected digits only/);
  assert.throws(() => normalizeMemberId('discord', '1234abcd'), /expected digits only/);
});

// --- WhatsApp LID rejection (the 2026-08-01 phantom-member incident) --------
// A WhatsApp LID (privacy id) is just digits once `@lid` is stripped, so it
// used to pass as an E.164 number. Four members were created that way and were
// permanently unmatchable: inbound messages always resolve LID -> phone via
// `senderPn`, so nothing ever equalled the stored id. One of them (Angela
// Donald, added 2026-07-21) sat as a gated guest for 11 days; another broke a
// project-membership check on 2026-08-01.

test('SECURITY: a WhatsApp LID is refused as a member id — it can never match a real sender, and routing it as a phone JID could reach an unrelated number', () => {
  // The four ids actually created in production by this bug.
  for (const lid of ['205995875803153', '177983595790491', '132822417318087', '89455629213795']) {
    assert.throws(
      () => normalizeMemberId('whatsapp', lid),
      /probably a WhatsApp LID/,
      `${lid} (a real LID from the incident) must be refused`,
    );
  }
});

test('the LID rejection message is actionable — it names the cause and what to supply instead', () => {
  assert.throws(
    () => normalizeMemberId('whatsapp', '205995875803153'),
    /roster or a group listing.*actual phone number in E\.164 form/s,
  );
});

test('every real member number in production still validates — the LID bound must not cost a legitimate add', () => {
  // The five genuine WhatsApp members left after the phantom rows were removed.
  for (const phone of ['64272480362', '64273938855', '6421807830', '642041824635', '64220608616']) {
    assert.equal(normalizeMemberId('whatsapp', phone), phone);
  }
  // Boundary: 13 digits is the last accepted length, 14 is the first refused.
  assert.equal(normalizeMemberId('whatsapp', '1234567890123'), '1234567890123');
  assert.throws(() => normalizeMemberId('whatsapp', '12345678901234'), /probably a WhatsApp LID/);
});

test('a too-SHORT WhatsApp id is diagnosed as a typo, never as a LID (PR #934 review)', () => {
  // Regression: the too-short and too-long branches were one condition, so a
  // 5-digit typo was told it was "probably a WhatsApp LID copied from the
  // roster" — a confident wrong answer during exactly the confusion this
  // validation exists to reduce. LIDs are long (14-15 digits); a short id
  // cannot be one.
  for (const short of ['12345', '123456', '1']) {
    assert.throws(() => normalizeMemberId('whatsapp', short), /it is too short/);
    assert.throws(() => normalizeMemberId('whatsapp', short), /missing country code|truncated/);
    // The LID diagnosis must NOT appear.
    try {
      normalizeMemberId('whatsapp', short);
      assert.fail(`${short} should have been rejected`);
    } catch (err) {
      assert.doesNotMatch(
        (err as Error).message,
        /LID|roster|group listing/,
        `a too-short id must not be blamed on a LID (got: ${(err as Error).message})`,
      );
    }
  }
});

test('the too-LONG branch keeps its LID diagnosis, and the two messages stay distinct', () => {
  assert.throws(() => normalizeMemberId('whatsapp', '205995875803153'), /it is too long/);
  assert.throws(() => normalizeMemberId('whatsapp', '205995875803153'), /probably a WhatsApp LID/);
});

// --- LID -> phone resolution (the persisted mapping's payoff) --------------
// A LID is the only id group metadata and `list_roster` expose, so an admin
// genuinely cannot tell it from a number. When the adapter has LEARNED that
// LID's phone from a real message envelope, resolve it rather than refuse —
// refusing something we can answer is just friction.

test('resolveWhatsappLid: a KNOWN LID resolves to its learned phone number', async () => {
  const resolved = await resolveWhatsappLid('205995875803153', async (lid) => {
    assert.equal(lid, '205995875803153', 'looks the LID up verbatim');
    return '64272480362';
  });
  assert.equal(resolved, '64272480362');
});

test('resolveWhatsappLid: an UNKNOWN LID resolves to null so the caller falls through to the explanatory error', async () => {
  assert.equal(await resolveWhatsappLid('100515186753604', async () => null), null);
});

test('resolveWhatsappLid: a normal phone number is never touched — the lookup is not even attempted', async () => {
  let looked = false;
  const out = await resolveWhatsappLid('64272480362', async () => {
    looked = true;
    return '99999999999';
  });
  assert.equal(out, null, 'a valid-length number is left for normalizeMemberId to accept as-is');
  assert.equal(looked, false, 'it can never reinterpret an id that would otherwise be accepted');
});

test('resolveWhatsappLid: non-numeric input is ignored', async () => {
  assert.equal(await resolveWhatsappLid('not-a-number', async () => '64272480362'), null);
});

test('SECURITY: a corrupt mapping cannot smuggle an invalid id past validation', async () => {
  // If the stored phone is itself junk (another LID, a truncated number), the
  // resolution must fail closed rather than hand the caller something
  // normalizeMemberId would have rejected.
  for (const bad of ['177983595790491', '123', 'lid:205995875803153', '']) {
    assert.equal(
      await resolveWhatsappLid('205995875803153', async () => bad),
      null,
      `a mapping to "${bad}" must not resolve`,
    );
  }
});

test('resolveWhatsappLid: a leading + on the supplied LID is tolerated', async () => {
  assert.equal(await resolveWhatsappLid('+205995875803153', async () => '64272480362'), '64272480362');
});
