import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — voiceTranscribe imports it.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const { ffmpegDecodeArgs, pcmBufferToFloat32 } = await import('../src/media/voiceTranscribe.js');

test('ffmpegDecodeArgs pins mono / 16 kHz / f32le raw PCM from stdin to stdout', () => {
  const args = ffmpegDecodeArgs();
  const joined = args.join(' ');
  // Whisper requires exactly these; a drift here silently corrupts every transcript.
  assert.ok(joined.includes('-i pipe:0'), 'reads the encoded audio from stdin');
  assert.ok(joined.includes('pipe:1'), 'writes decoded PCM to stdout');
  assert.equal(args[args.indexOf('-ac') + 1], '1', 'mono');
  assert.equal(args[args.indexOf('-ar') + 1], '16000', '16 kHz');
  assert.equal(args[args.indexOf('-f') + 1], 'f32le', '32-bit float little-endian raw stream');
});

test('pcmBufferToFloat32 round-trips little-endian float32 samples', () => {
  const samples = [0, 1, -1, 0.5, -0.25];
  const buf = Buffer.alloc(samples.length * 4);
  samples.forEach((s, i) => buf.writeFloatLE(s, i * 4));
  const out = pcmBufferToFloat32(buf);
  assert.equal(out.length, samples.length);
  samples.forEach((s, i) => assert.ok(Math.abs(out[i] - s) < 1e-6, `sample ${i}`));
});

test('pcmBufferToFloat32 drops a trailing partial sample instead of reading past the buffer', () => {
  // 9 bytes = two whole f32 samples + 1 stray byte; the stray byte must be ignored.
  const buf = Buffer.alloc(9);
  buf.writeFloatLE(0.75, 0);
  buf.writeFloatLE(-0.5, 4);
  const out = pcmBufferToFloat32(buf);
  assert.equal(out.length, 2, 'only whole 4-byte samples are decoded');
  assert.ok(Math.abs(out[0] - 0.75) < 1e-6);
  assert.ok(Math.abs(out[1] + 0.5) < 1e-6);
});

test('pcmBufferToFloat32 handles an empty buffer', () => {
  assert.equal(pcmBufferToFloat32(Buffer.alloc(0)).length, 0);
});
