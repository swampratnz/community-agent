import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_TOOLS,
  MEMBER_TOOLS,
  SUPER_ADMIN_TOOLS,
  assertAtLeast,
  atLeast,
  toolsForRole,
} from '../src/auth/rbac.js';

test('tier ordering', () => {
  assert.ok(atLeast('super_admin', 'admin'));
  assert.ok(atLeast('admin', 'member'));
  assert.ok(atLeast('member', 'guest'));
  assert.ok(!atLeast('member', 'admin'));
  assert.ok(!atLeast('admin', 'super_admin'));
  assert.ok(!atLeast('guest', 'member'));
});

test('SECURITY: members and guests never get admin or super-admin tools', () => {
  for (const role of ['member', 'guest'] as const) {
    const tools = toolsForRole(role);
    for (const t of [...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
      assert.ok(!tools.includes(t), `${role} tools must not include ${t}`);
    }
    assert.deepEqual(tools, [...MEMBER_TOOLS]);
  }
});

test('SECURITY: admins never get super-admin tools', () => {
  const tools = toolsForRole('admin');
  for (const t of SUPER_ADMIN_TOOLS) {
    assert.ok(!tools.includes(t), `admin tools must not include ${t}`);
  }
  for (const t of [...MEMBER_TOOLS, ...ADMIN_TOOLS]) {
    assert.ok(tools.includes(t), `admin tools must include ${t}`);
  }
});

test('super admin gets the full surface', () => {
  const tools = toolsForRole('super_admin');
  for (const t of [...MEMBER_TOOLS, ...ADMIN_TOOLS, ...SUPER_ADMIN_TOOLS]) {
    assert.ok(tools.includes(t), `super_admin tools must include ${t}`);
  }
});

test('assertAtLeast enforces the hierarchy', () => {
  assert.throws(() => assertAtLeast('member', 'admin', 'announce'), /Permission denied/);
  assert.throws(() => assertAtLeast('admin', 'super_admin', 'grant_admin'), /Permission denied/);
  assert.doesNotThrow(() => assertAtLeast('admin', 'admin', 'announce'));
  assert.doesNotThrow(() => assertAtLeast('super_admin', 'admin', 'announce'));
});
