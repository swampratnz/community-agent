/**
 * Persona registry mechanism (agent-base plan §3 `promptSections` row —
 * "persona roster", Phase-1 item 8): the base-owned half of what used to be
 * one hard-coded map in `personas.ts`. A module registers today's roster
 * (this repo: Dave, in `personas.ts`); the base owns resolution and turn
 * selection.
 *
 * A persona only changes how the bot SOUNDS. It never changes what the bot
 * can DO — permissions come from the caller's RBAC tier and the tool gating,
 * never from which persona is speaking. This keeps personas from becoming a
 * privilege-escalation surface ("let me talk to the admin bot"). Every
 * persona's turn is assembled with the identical security guidelines and
 * role-derived tool set; only the `voice` block differs.
 *
 * Registration is append-only and id-unique: re-registering an existing id
 * throws (a voice swap is a code change, never a second registration), and
 * exactly one persona must be flagged as the default.
 */

export interface Persona {
  id: string;
  /** Display name. */
  name: string;
  /** Lowercase tokens that summon this persona by @name / mention. */
  aliases: string[];
  /** Voice block injected into the system prompt (never overrides the rules). */
  voice: string;
}

const registry = new Map<string, Persona>();
let defaultId: string | null = null;

/** Register one persona; `isDefault` marks the roster's fallback voice. */
export function registerPersona(persona: Persona, opts?: { isDefault?: boolean }): void {
  if (registry.has(persona.id)) {
    throw new Error(
      `persona '${persona.id}' already registered — a voice swap is a code change, not a re-registration`,
    );
  }
  if (opts?.isDefault) {
    if (defaultId !== null) {
      throw new Error(`default persona already set ('${defaultId}') — exactly one default is allowed`);
    }
    defaultId = persona.id;
  }
  registry.set(persona.id, persona);
}

/** The registered default persona's id; throws if no roster ever registered one. */
export function defaultPersonaId(): string {
  if (defaultId === null) {
    throw new Error('no default persona registered — import the community persona roster first');
  }
  return defaultId;
}

/** Resolve a persona by id, falling back to the default for null/unknown ids. */
export function getPersona(id: string | null | undefined): Persona {
  const fallback = registry.get(defaultPersonaId());
  if (!fallback) {
    throw new Error('default persona id has no registered persona');
  }
  return (id && registry.get(id)) || fallback;
}

/** The registered roster, in registration order (insertion-ordered Map). */
export function allPersonas(): Persona[] {
  return [...registry.values()];
}

/**
 * Choose the persona for a turn. Today: summon a non-default persona by leading
 * @name/alias, else the default. Channel- and task-based selection can slot in
 * here later without touching callers.
 */
export function selectPersona(opts: { text?: string }): Persona {
  const text = (opts.text ?? '').trim().toLowerCase();
  if (text) {
    // First token, stripped of a leading @ and trailing punctuation.
    const firstToken = text
      .split(/\s+/)[0]
      ?.replace(/^@/, '')
      .replace(/[^\w]+$/, '');
    if (firstToken) {
      for (const persona of registry.values()) {
        if (persona.id !== defaultPersonaId() && persona.aliases.includes(firstToken)) {
          return persona;
        }
      }
    }
  }
  return getPersona(null);
}
