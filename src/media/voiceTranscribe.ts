import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Local speech-to-text for WhatsApp voice notes (super-admin only; gated in the
 * Baileys adapter). Uses transformers.js Whisper — the SAME "download once, run
 * locally, no external API, no extra key" pattern as text embeddings
 * (storage/embeddings.ts), so audio never leaves the host and the
 * subscription-only auth model is preserved. Default: Xenova/whisper-base.en.
 *
 * WhatsApp delivers voice notes as OGG/Opus; Whisper wants mono 16 kHz PCM, so
 * we shell out to ffmpeg (a host prerequisite — see docs/DEPLOYMENT.md) to
 * decode. Nothing here is reached unless WHATSAPP_VOICE_ENABLED is on and the
 * sender is a super admin.
 */

/** Target sample rate Whisper expects. */
const TARGET_SAMPLE_RATE = 16_000;

/**
 * Decode an arbitrary audio container (OGG/Opus for WA voice notes) to the raw
 * mono float32 PCM at 16 kHz that transformers.js Whisper consumes. Pure-ish:
 * spawns ffmpeg, feeds `input` on stdin, returns the decoded samples. Rejects
 * if ffmpeg is missing (ENOENT) or exits non-zero.
 */
export function ffmpegDecodeArgs(): string[] {
  // stdin -> mono, 16 kHz, 32-bit float little-endian raw PCM -> stdout.
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-ac',
    '1',
    '-ar',
    String(TARGET_SAMPLE_RATE),
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    'pipe:1',
  ];
}

/** Reinterpret a little-endian f32 byte buffer as Float32Array (copy, aligned). */
export function pcmBufferToFloat32(buf: Buffer): Float32Array {
  const usableLen = buf.length - (buf.length % 4);
  const out = new Float32Array(usableLen / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

export async function decodeToPcm(input: Buffer): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    const ff = spawn('ffmpeg', ffmpegDecodeArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let errText = '';
    ff.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new Error('ffmpeg not found on host — required for voice transcription (see DEPLOYMENT.md)')
          : err,
      );
    });
    ff.stdout.on('data', (d: Buffer) => out.push(d));
    ff.stderr.on('data', (d: Buffer) => {
      errText += d.toString();
    });
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${errText.slice(0, 300)}`));
      resolve(pcmBufferToFloat32(Buffer.concat(out)));
    });
    ff.stdin.on('error', () => {
      /* broken pipe if ffmpeg dies early — surfaced via the close/error paths */
    });
    ff.stdin.end(input);
  });
}

// transformers.js is ESM and heavy; load lazily and reuse the pipeline so we
// pay the model download/init once (mirrors storage/embeddings.ts).
type Transcriber = (
  audio: Float32Array,
  opts: { chunk_length_s: number; stride_length_s: number },
) => Promise<{ text: string }>;

let transcriberPromise: Promise<Transcriber> | null = null;

async function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = true; // offline-friendly after first download
      logger.info({ model: config.whatsapp.voice.model }, 'Loading voice transcription model');
      const pipe = (await pipeline(
        'automatic-speech-recognition',
        config.whatsapp.voice.model,
      )) as unknown as Transcriber;
      logger.info('Voice transcription model ready');
      return pipe;
    })();
  }
  return transcriberPromise;
}

/**
 * Decode + transcribe a WhatsApp voice note to plain text. Returns the trimmed
 * transcript (may be empty for silence/noise). Throws on decode/model failure —
 * the adapter catches and drops the note rather than surfacing internals.
 */
export async function transcribeVoiceNote(audio: Buffer): Promise<string> {
  const pcm = await decodeToPcm(audio);
  if (pcm.length === 0) return '';
  const transcriber = await getTranscriber();
  // chunk_length_s enables Whisper's long-form chunking so a note longer than
  // the model's 30 s window still transcribes fully (we cap total length in the
  // adapter regardless).
  const { text } = await transcriber(pcm, { chunk_length_s: 30, stride_length_s: 5 });
  return text.trim();
}
