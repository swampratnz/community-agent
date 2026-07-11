// Throwaway entrypoint for tests/config.test.ts's SECURITY subprocess test —
// importing src/config.ts triggers its at-import-time env validation
// (process.exit(1) on failure), which must happen in an isolated child
// process rather than the shared test-file process. Prints the resolved
// config on success so a caller can assert on values that depend on an env
// combination the shared test-file process can't reproduce (config.js
// resolves once per process, at import time).
import { config } from '../../src/config.js';

console.log(JSON.stringify(config));
