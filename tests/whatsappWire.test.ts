import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAudio,
  extractText,
  isLidJid,
  isPhoneUserId,
  jidLocalPart,
  lidFallbackId,
  senderPhoneNumber,
  unwrapMessage,
} from '../src/platforms/whatsapp/wire.js';
import type { WAMessage } from '@whiskeysockets/baileys';

test('jidLocalPart strips device suffix and domain', () => {
  assert.equal(jidLocalPart('64211234567@s.whatsapp.net'), '64211234567');
  assert.equal(jidLocalPart('64211234567:12@s.whatsapp.net'), '64211234567');
  assert.equal(jidLocalPart('123@lid'), '123');
  assert.equal(jidLocalPart(undefined), '');
});

test('isLidJid', () => {
  assert.equal(isLidJid('123@lid'), true);
  assert.equal(isLidJid('64211234567@s.whatsapp.net'), false);
  assert.equal(isLidJid(null), false);
});

test('senderPhoneNumber: DM with plain phone JID', () => {
  const msg = { key: { remoteJid: '64211234567@s.whatsapp.net' } } as WAMessage;
  assert.equal(senderPhoneNumber(msg, false), '64211234567');
});

test('senderPhoneNumber: LID DM resolves via senderPn', () => {
  const msg = {
    key: { remoteJid: '99887766554433@lid', senderPn: '64211234567@s.whatsapp.net' },
  } as WAMessage;
  assert.equal(senderPhoneNumber(msg, false), '64211234567');
});

test('senderPhoneNumber: LID DM without senderPn yields empty (never a fake admin match)', () => {
  const msg = { key: { remoteJid: '99887766554433@lid' } } as WAMessage;
  assert.equal(senderPhoneNumber(msg, false), '');
});

test('senderPhoneNumber: group participant, plain and LID', () => {
  const plain = { key: { remoteJid: 'g@g.us', participant: '64211234567@s.whatsapp.net' } } as WAMessage;
  assert.equal(senderPhoneNumber(plain, true), '64211234567');

  const lid = {
    key: { remoteJid: 'g@g.us', participant: '112233@lid', participantPn: '64219876543@s.whatsapp.net' },
  } as WAMessage;
  assert.equal(senderPhoneNumber(lid, true), '64219876543');
});

test('SECURITY: lid: fallback ids are never valid phone targets', () => {
  // A LID local part looks numeric — the prefix must make it unroutable so
  // warn/kick can never send to an unrelated real phone number.
  assert.equal(isPhoneUserId('64211234567'), true);
  assert.equal(isPhoneUserId(lidFallbackId('99887766554433')), false);
  assert.equal(isPhoneUserId('99887766554433999999'), false); // too long
  assert.equal(isPhoneUserId(''), false);
  assert.equal(isPhoneUserId('unknown'), false);
});

test('unwrapMessage reaches through ephemeral and view-once wrappers', () => {
  const inner = { conversation: 'hello' };
  assert.equal(unwrapMessage({ ephemeralMessage: { message: inner } })?.conversation, 'hello');
  assert.equal(unwrapMessage({ viewOnceMessageV2: { message: inner } })?.conversation, 'hello');
  assert.equal(
    unwrapMessage({ ephemeralMessage: { message: { viewOnceMessage: { message: inner } } } })?.conversation,
    'hello',
  );
  assert.equal(unwrapMessage(null), null);
});

test('extractText reads text from wrapped messages (disappearing-messages groups)', () => {
  const msg = {
    key: { remoteJid: 'g@g.us' },
    message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'hi team' } } } },
  } as unknown as WAMessage;
  assert.equal(extractText(msg).text, 'hi team');
});

test('extractText returns empty for a voice note — the text path never actions raw audio', () => {
  const msg = {
    key: { remoteJid: '64211234567@s.whatsapp.net' },
    message: { audioMessage: { seconds: 5, ptt: true } },
  } as unknown as WAMessage;
  assert.equal(extractText(msg).text, '', 'audio carries no text — only the voice path may action it');
});

test('extractAudio returns the audio payload + its own contextInfo for a voice note', () => {
  const ctx = { participant: '64299999999@s.whatsapp.net' };
  const msg = {
    key: { remoteJid: 'g@g.us' },
    message: { audioMessage: { seconds: 7, ptt: true, contextInfo: ctx } },
  } as unknown as WAMessage;
  const { audio, contextInfo } = extractAudio(msg);
  assert.equal(audio?.seconds, 7);
  assert.equal(
    contextInfo?.participant,
    '64299999999@s.whatsapp.net',
    'reply-to-bot still detectable on audio',
  );
});

test('extractAudio reaches through wrappers and returns null for a text message', () => {
  const wrapped = {
    message: { ephemeralMessage: { message: { audioMessage: { seconds: 3 } } } },
  } as unknown as WAMessage;
  assert.equal(extractAudio(wrapped).audio?.seconds, 3, 'unwraps ephemeral like extractText does');

  const textMsg = {
    message: { conversation: 'hello' },
  } as unknown as WAMessage;
  assert.equal(extractAudio(textMsg).audio, null, 'a text message has no audio payload');
});
