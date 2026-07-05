import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  /** Extension matching the sniffed bytes (grok may save jpg under a .png name). */
  ext: string;
}

/**
 * Sniff the real image type from magic bytes — grok "copies the generated
 * image to the requested path" but the bytes are whatever it produced (often
 * JPEG), so never trust the requested extension.
 */
export function sniffImageType(buf: Buffer): { mimeType: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  return null;
}

/**
 * Generate an image with the Grok Build CLI. Spawns `grok -p` headlessly, has
 * it save to a private temp file, and returns the bytes. The CLI uses the
 * host's SuperGrok subscription login (no API key). Throws on timeout, a
 * non-zero exit, or if no recognisable image is produced.
 *
 * The prompt is passed as an argv element (never a shell string), so there is
 * no shell-injection surface even though the tool is admin-gated.
 */
export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const dir = await mkdtemp(join(tmpdir(), 'grokimg-'));
  const outPath = join(dir, 'image.png');
  const instruction =
    `Generate an image based on the description below and save it to ${outPath} using your ` +
    `built-in image generation tool — do not write code. Reply with only the saved file path.\n\n` +
    `Description: ${prompt}`;
  try {
    await runGrok(instruction);
    const data = await readFile(outPath).catch(() => null);
    if (!data || data.length === 0) throw new Error('Grok did not produce an image file.');
    const kind = sniffImageType(data);
    if (!kind) throw new Error('Grok produced an unrecognised (non-image) file.');
    return { data, ...kind };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runGrok(instruction: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      config.imageGen.grokBin,
      ['--always-approve', '--disable-web-search', '-p', instruction],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: config.imageGen.timeoutMs },
    );
    let stderr = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Grok image generation timed out after ${config.imageGen.timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(-400) }, 'grok image generation failed');
        reject(new Error(`Grok exited with code ${code}.`));
        return;
      }
      resolve();
    });
  });
}
