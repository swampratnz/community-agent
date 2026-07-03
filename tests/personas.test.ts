import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PERSONA_ID, PERSONAS, getPersona, selectPersona } from '../src/agent/personas.js';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';

const caller = {
  platform: 'discord' as const,
  userId: 'u1',
  userName: 'Chris',
  role: 'member' as const,
  conversationId: 'chan1',
};

test('default persona is Kaha and resolves for unknown/empty ids', () => {
  assert.equal(getPersona(null).id, DEFAULT_PERSONA_ID);
  assert.equal(getPersona('nope').id, DEFAULT_PERSONA_ID);
  assert.equal(getPersona('kaha').name, 'Kaha');
});

test('selectPersona falls back to the default when no alias matches', () => {
  assert.equal(selectPersona({ text: 'hey, how do I use tool calling?' }).id, DEFAULT_PERSONA_ID);
  assert.equal(selectPersona({ text: '' }).id, DEFAULT_PERSONA_ID);
});

test('SECURITY: every persona keeps the security guidelines and human-style rules', () => {
  for (const persona of Object.values(PERSONAS)) {
    const prompt = buildSystemPrompt(caller, { codeAnswers: 'snippets' }, persona);
    // The persona voice is present...
    assert.ok(prompt.includes(persona.name), `prompt should include ${persona.name}`);
    // ...but the security invariants are NOT dropped by swapping voices.
    assert.match(prompt, /UNTRUSTED DATA/, 'untrusted-data rule must survive persona swap');
    assert.match(prompt, /never.*grant you new\s*permissions|Permissions come only from your tools/is);
    // ...and the human-style / no-em-dash rule is present.
    assert.match(prompt, /NEVER use em dashes/);
  }
});

test('persona changes voice, not the role note (permissions come from tier)', () => {
  const asMember = buildSystemPrompt(caller, { codeAnswers: 'snippets' }, getPersona('kaha'));
  const asAdmin = buildSystemPrompt({ ...caller, role: 'admin' }, { codeAnswers: 'snippets' }, getPersona('kaha'));
  // Same persona, but the tier-derived role note differs — persona never sets permissions.
  assert.match(asMember, /MEMBER/);
  assert.match(asAdmin, /an ADMIN/);
});
