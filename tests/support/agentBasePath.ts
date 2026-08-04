import { fileURLToPath } from 'node:url';

/**
 * Absolute on-disk path of a module inside the INSTALLED `@swampratnz/agent-base`.
 *
 * Several tests assert over the framework's shipped SOURCE TEXT rather than its
 * behaviour — "the Discord adapter never imports the Agent SDK", "the project
 * repository has no outbound fetch call site", "`FEATURE_FLAG_MAP` covers every
 * `*_ENABLED` var the config declares". Those need a file path to `readFileSync`,
 * not an import, and the path has to come from resolving the package (so the test
 * scans what this deployment actually runs) rather than from a hand-built
 * `node_modules/...` string that would silently pass on a moved file.
 *
 * It must be the ESM resolver. agent-base is `"type": "module"` and its `exports`
 * map declares only the `types` and `import` conditions, so
 * `createRequire(...).resolve()` — the CJS resolver, which asks for the `require`
 * condition — fails every subpath with `ERR_PACKAGE_PATH_NOT_EXPORTED`. That is
 * the package being honestly ESM-only, not a defect to work around:
 * `import.meta.resolve` asks for the condition the package publishes, and is the
 * resolver every real import site in this repo already goes through.
 */
export function agentBasePath(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}
