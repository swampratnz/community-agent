Test-side composition helpers.

In production the community content is registered ONCE, in declaration order,
by `createAgent({ modules: [nzCommunityModule] })` (see
`src/module/agentModule.ts`). Before the agent-base package flip each content
file registered itself at its own module scope, so a test simply imported the
file for its side effect — `import '../src/module/strings/notices.js';`.

Those side effects are gone: a value registered twice throws, and the manifest
is the single place the surface is declared. Each helper here performs exactly
one of the manifest's registrations, idempotently, so a test can opt into the
slice it needs without pulling the whole composition (and without the import
weight — several suites deliberately import a leaf notice module and nothing
else). `node:test` runs each test FILE in its own process, so the guards only
have to cope with repeated imports inside one file.

Nothing here is a `*.test.ts`, so the runner never collects it.
