process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
const { COMMUNITY_TOOL_TIERS } = await import('./../src/module/agent/tools/index.js');
const strip = (t: string) => t.replace('mcp__community__', '');
for (const key of ['member', 'admin', 'superAdmin', 'discordOnly'] as const) {
  const list = [...COMMUNITY_TOOL_TIERS[key]].map(strip).sort();
  console.log(`  ${key}: [`);
  for (const t of list) console.log(`    '${t}',`);
  console.log(`  ],`);
}
