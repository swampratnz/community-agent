import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemberId } from '../src/auth/memberId.js';

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

test('rejects non-numeric ids', () => {
  assert.throws(() => normalizeMemberId('whatsapp', 'not-a-number'), /expected digits only/);
  assert.throws(() => normalizeMemberId('discord', '1234abcd'), /expected digits only/);
});
