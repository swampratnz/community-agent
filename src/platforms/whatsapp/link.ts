/**
 * One-time WhatsApp linking helper.
 *
 *   npm run whatsapp:link
 *
 * Prints a QR code in the terminal. On the phone holding the dedicated number:
 * WhatsApp > Settings > Linked Devices > Link a device > scan it.
 * Credentials are saved to WHATSAPP_AUTH_DIR and reused by the service.
 */
import { BaileysAdapter } from './baileysAdapter.js';
import { logger } from '../../logger.js';

const adapter = new BaileysAdapter();
adapter.onMessage(() => {
  /* no-op during linking */
});

adapter
  .start()
  .then(() => {
    logger.info('Waiting for QR scan… once "WhatsApp connected" appears you can Ctrl-C and start the service.');
  })
  .catch((err) => {
    logger.error({ err }, 'Linking failed');
    process.exit(1);
  });
