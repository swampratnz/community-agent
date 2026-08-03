/**
 * Generic per-turn state plumbing (agent-base plan §3, `intercepts` +
 * `postTurnHandlers` row): base owns the MECHANISM — two empty,
 * module-augmentable interfaces and a finalizer registry — while the KEYS
 * (and what they mean) are declared and documented in ONE community-owned
 * file, `src/agent/communityTurnState.ts`. This replaces the five hardcoded
 * community fields (`knowledgeEntryId`, `unhelpfulAnswerRated`,
 * `humanHelpRequested`, `knowledgeGapCluster`, `staleKnowledgeAlertIds`)
 * that used to be threaded name-by-name through `ToolServerTurnState` →
 * `TurnOutcome` → `AgentReply` → router readers.
 */

/**
 * Turn-scoped, mutable scratch state threaded into `buildToolServer` by
 * `execTurn` (originating in issue #411) — tool handlers write into it
 * during the turn. Base declares it EMPTY; modules add their keys via
 * `declare module` augmentation (all keys optional, so `execTurn`'s `{}`
 * initializer stays module-agnostic).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ToolServerTurnState {}

/**
 * The read-only bag a finished turn surfaces as `AgentReply.turnState` —
 * only ever populated on a genuine success (`TurnOutcome.ok === true`),
 * preserving the old fields' "never set on a fallback/error reply"
 * contract. Same augmentation pattern as `ToolServerTurnState`; consumed by
 * the router's registered post-turn handlers, never by base code.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TurnStateBag {}

/**
 * Maps the raw tool-server scratch state to the keys this module wants to
 * surface on the reply — the module-owned half of what used to be the five
 * hardcoded conditional spreads at the bottom of `execTurn`.
 */
export type TurnStateFinalizer = (turnState: ToolServerTurnState) => Partial<TurnStateBag>;

const finalizers: TurnStateFinalizer[] = [];

/** Register a module's finalizer — called once at module load (communityTurnState.ts). */
export function registerTurnStateFinalizer(finalizer: TurnStateFinalizer): void {
  finalizers.push(finalizer);
}

/**
 * Run every registered finalizer over the turn's scratch state and merge the
 * results. Called by `execTurn` on the genuine-success path ONLY — so a key
 * can never ride a fallback/error reply, exactly like the fields it
 * replaces.
 */
export function finalizeTurnState(turnState: ToolServerTurnState): Partial<TurnStateBag> {
  const bag: Partial<TurnStateBag> = {};
  for (const finalizer of finalizers) Object.assign(bag, finalizer(turnState));
  return bag;
}
