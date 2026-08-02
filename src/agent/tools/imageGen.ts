import { z } from 'zod';
import { assertAtLeast } from '../../auth/tiers.js';
import { config, onDiskSecretPaths } from '../../config.js';
import { logger, hashId } from '../../logger.js';
import { generateImage } from '../../media/grokImage.js';
import { makeCalendarDayReserver } from '../../util/rateReservation.js';
import { text } from './helpers.js';
import { defineTool } from './types.js';

/** Users with an image generation currently in flight — blocks overlapping spawns per user. */
const imageGenInFlight = new Set<string>();
/**
 * Reserve one image-generation slot for `key` against today's per-user cap
 * (`config.imageGen.dailyLimit`; a limit of 0 means unlimited). Returns
 * false (and does not increment) if the cap is already reached.
 *
 * A reservation is deliberately NOT refunded if the generation later fails: the
 * cap bounds heavyweight `grok` subprocess spawns, and a failed attempt still
 * spawned (and paid for) one — so a timeout/crash counts, and induced-failure
 * retry spam can't bypass the cap.
 */
const reserveImageGenDaily = makeCalendarDayReserver();

export const imageGenTools = [
  defineTool({
    name: 'generate_image',
    description:
      'Generate an image from a text description and post it into the current conversation. Admin only. ' +
      "Uses the host's Grok Build CLI (SuperGrok subscription). Takes up to a minute.",
    minTier: 'admin',
    featureFlag: (cfg) => cfg.imageGen.enabled,
    readOnlyHint: false,
    schema: { prompt: z.string().min(1).max(1000).describe('Description of the image to generate') },
    handler: async (args, { caller, adapter }) => {
      assertAtLeast(caller.role, 'admin', 'generate_image');
      if (!config.imageGen.enabled) {
        return text('Image generation is not enabled on this server.', true);
      }
      if (!adapter.sendImage) {
        return text(`Image generation isn't available on ${caller.platform}.`, true);
      }
      const key = `${caller.platform}:${caller.userId}`;
      if (imageGenInFlight.has(key)) {
        return text('You already have an image generating — let it finish before starting another.', true);
      }
      if (!reserveImageGenDaily(key, config.imageGen.dailyLimit)) {
        return text(
          `You've hit today's image limit (${config.imageGen.dailyLimit}). Try again tomorrow.`,
          true,
        );
      }
      imageGenInFlight.add(key);
      try {
        const image = await generateImage(args.prompt, onDiskSecretPaths());
        await adapter.sendImage(
          caller.conversationId,
          {
            data: image.data,
            filename: `image.${image.ext}`,
            mimeType: image.mimeType,
          },
          args.prompt,
        );
        logger.info(
          { actor: hashId(caller.userId), platform: caller.platform, bytes: image.data.length },
          'generate_image posted',
        );
        return text('Image posted.');
      } catch (err) {
        logger.warn({ err, actor: hashId(caller.userId) }, 'generate_image failed');
        return text(`Image generation failed: ${err instanceof Error ? err.message : String(err)}`, true);
      } finally {
        imageGenInFlight.delete(key);
      }
    },
  }),
];
