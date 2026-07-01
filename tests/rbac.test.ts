import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_TOOLS,
  USER_TOOLS,
  assertAdmin,
  resolveDiscordRole,
  resolveWhatsappRole,
  toolsForRole,
} from '../src/auth/rbac.js';

test('user role never gets admin tools', () => {
  const tools = toolsForRole('user');
  for (const t of ADMIN_TOOLS) {
    assert.ok(!tools.includes(t), `user tools must not include ${t}`);
  }
  assert.deepEqual(tools, [...USER_TOOLS]);
});

test('admin role gets user + admin tools', () => {
  const tools = toolsForRole('admin');
  for (const t of [...USER_TOOLS, ...ADMIN_TOOLS]) {
    assert.ok(tools.includes(t), `admin tools must include ${t}`);
  }
});

test('assertAdmin throws for user, passes for admin', () => {
  assert.throws(() => assertAdmin('user', 'announce'), /Permission denied/);
  assert.doesNotThrow(() => assertAdmin('admin', 'announce'));
});

test('Discord role resolution: by user id, by role id, default user', () => {
  const cfg = { adminRoleIds: ['r-admin'], adminUserIds: ['u-owner'] };
  assert.equal(resolveDiscordRole('u-owner', [], cfg), 'admin');
  assert.equal(resolveDiscordRole('u-member', ['r-admin', 'r-other'], cfg), 'admin');
  assert.equal(resolveDiscordRole('u-member', ['r-other'], cfg), 'user');
  assert.equal(resolveDiscordRole('u-member', [], cfg), 'user');
});

test('WhatsApp role resolution matches configured numbers only', () => {
  assert.equal(resolveWhatsappRole('64211234567', ['64211234567']), 'admin');
  assert.equal(resolveWhatsappRole('64219999999', ['64211234567']), 'user');
  // A LID (not a phone number) must never match an admin number.
  assert.equal(resolveWhatsappRole('123456789012345', ['64211234567']), 'user');
  assert.equal(resolveWhatsappRole('', ['64211234567']), 'user');
});
