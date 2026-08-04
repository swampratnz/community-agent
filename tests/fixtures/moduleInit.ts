// Throwaway entrypoint for tests/agentModule.test.ts's SECURITY subprocess
// test. The module manifest's `init()` reads the config singleton, which is
// parsed once per process at import time — so the "wrong display settings"
// case has to run in its own child, exactly like fixtures/loadConfig.ts.
// Exits 0 and prints OK when init() accepts the environment.
import { nzCommunityModule } from '../../src/module/agentModule.js';

await nzCommunityModule.init?.();
console.log('OK');
