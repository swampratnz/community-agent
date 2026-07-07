// Throwaway entrypoint for tests/config.test.ts's SECURITY subprocess test —
// importing src/config.ts triggers its at-import-time env validation
// (process.exit(1) on failure), which must happen in an isolated child
// process rather than the shared test-file process.
import '../../src/config.js';
