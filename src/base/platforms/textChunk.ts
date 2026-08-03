/**
 * Split text into chunks no longer than `size`, preferring to break on the
 * last newline before the boundary so messages don't get cut mid-line. Pure
 * and platform-agnostic so both the Discord (2000 char) and WhatsApp Cloud
 * (4096 char) adapters can share one tested implementation.
 */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size; // avoid tiny chunks if no newline near the limit
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
