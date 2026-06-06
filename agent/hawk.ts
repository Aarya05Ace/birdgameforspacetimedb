// ─────────────────────────────────────────────────────────────────────────────
// hawk.ts — the LLM Hawk Agent  (ORIGINAL · "Best Use of SpacetimeDB" + Claude)
//
// A headless SpacetimeDB *client* that plays the predator. Every ~1.5s it:
//   1. reads the flock's live positions from the `player` table (subscription),
//   2. asks Claude Haiku 4.5 which bird to hunt + a tactic + a taunt,
//   3. writes that decision back via the `set_hawk_intent` reducer.
// The deterministic `world_tick` reducer then flies the hawk and resolves catches.
//
// LLM brains, DB muscle. The Anthropic key is read ONLY from the environment
// (ANTHROPIC_API_KEY) — it is never hardcoded and never shipped to the browser.
// If no key is set, the agent falls back to simple "hunt the most isolated bird"
// logic so the game still works.
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import { Identity } from 'spacetimedb';
import { DbConnection, tables } from '../src/module_bindings';

const HOST = process.env.STDB_HOST ?? 'ws://localhost:3000';
const DB = process.env.STDB_DB ?? 'birdgame';
const MODEL = 'claude-haiku-4-5';
const THINK_MS = 1500;

const hasKey = !!process.env.ANTHROPIC_API_KEY;
const anthropic = hasKey ? new Anthropic() : null;

// ── live mirror of the world (kept current by row callbacks) ─────────────────
type Bird = {
  id: Identity; hex: string; name?: string;
  x: number; y: number; z: number;
  alive: boolean; online: boolean; inFormation: boolean;
};
const birds = new Map<string, Bird>();
let hawk = { x: 0, y: 240, z: 0 };

function upsertBird(row: any) {
  birds.set(row.identity.toHexString(), {
    id: row.identity, hex: row.identity.toHexString(), name: row.name ?? undefined,
    x: row.x, y: row.y, z: row.z,
    alive: row.alive, online: row.online, inFormation: row.inFormation,
  });
}

// ── connect ──────────────────────────────────────────────────────────────────
const conn = DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB)
  .onConnect((c: any, identity: Identity) => {
    console.log(`🦅 Hawk Agent connected (${identity.toHexString().slice(0, 8)}) — ${hasKey ? 'Claude ' + MODEL : 'NO API KEY → fallback brain'}`);
    c.subscriptionBuilder()
      .onApplied(() => console.log('🦅 subscribed to flock; hunt begins'))
      .subscribe([tables.player, tables.hawk, tables.world]);
  })
  .onConnectError((_c: any, e: Error) => console.error('connect error:', e.message))
  .onDisconnect(() => console.log('🦅 disconnected'))
  .build();

conn.db.player.onInsert((_c: any, r: any) => upsertBird(r));
conn.db.player.onUpdate((_c: any, _o: any, r: any) => upsertBird(r));
conn.db.player.onDelete((_c: any, r: any) => birds.delete(r.identity.toHexString()));
conn.db.hawk.onInsert((_c: any, r: any) => { hawk = { x: r.x, y: r.y, z: r.z }; });
conn.db.hawk.onUpdate((_c: any, _o: any, r: any) => { hawk = { x: r.x, y: r.y, z: r.z }; });

// ── helpers ──────────────────────────────────────────────────────────────────
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function snapshot() {
  const prey = [...birds.values()].filter(b => b.alive && b.online);
  return prey.map((b, i) => {
    const others = prey.filter(o => o.hex !== b.hex);
    const nearest = others.length ? Math.min(...others.map(o => dist(b, o))) : 9999;
    return {
      i, name: b.name ?? b.hex.slice(0, 6),
      distFromHawk: Math.round(dist(b, hawk)),
      distToNearestBird: Math.round(nearest),
      protected: b.inFormation,
      id: b.id,
    };
  });
}

const DECIDE_TOOL: Anthropic.Tool = {
  name: 'decide_hunt',
  description: 'Choose which bird to hunt next and how.',
  input_schema: {
    type: 'object',
    properties: {
      target_index: { type: ['integer', 'null'], description: 'Index of the bird to hunt, or null to circle and wait for an opening.' },
      tactic: { type: 'string', enum: ['dive', 'stalk', 'circle', 'ambush'] },
      thought: { type: 'string', description: 'A short, menacing first-person line the hawk is thinking (<=110 chars).' },
    },
    required: ['target_index', 'tactic', 'thought'],
  } as any,
};

const SYSTEM =
  'You are a cunning, ruthless hawk hunting a flock of birds in a real-time game. ' +
  'Isolated birds — those far from the nearest other bird — are easy prey. Birds in a tight ' +
  'formation are PROTECTED ("protected": true): do not target them, you cannot catch them. ' +
  'Prefer the most isolated, unprotected bird; break ties by who is closest to you. ' +
  'If every bird is protected, return target_index null and circle. Keep your thought short and theatrical.';

function fallbackDecision(snap: ReturnType<typeof snapshot>) {
  const open = snap.filter(b => !b.protected);
  if (!open.length) return { target: undefined as Identity | undefined, tactic: 'circle', thought: 'Huddled together… I can wait. They always stray.' };
  open.sort((a, b) => (b.distToNearestBird - a.distToNearestBird) || (a.distFromHawk - b.distFromHawk));
  const t = open[0];
  return { target: t.id as Identity | undefined, tactic: 'dive', thought: `The one called ${t.name} drifts alone. Mine.` };
}

async function llmDecision(snap: ReturnType<typeof snapshot>) {
  const payload = {
    hawk: { x: Math.round(hawk.x), y: Math.round(hawk.y), z: Math.round(hawk.z) },
    birds: snap.map(({ id, ...rest }) => rest), // drop the Identity object from the prompt
  };
  const res = await anthropic!.messages.create({
    model: MODEL,
    max_tokens: 256,
    system: SYSTEM,
    tools: [DECIDE_TOOL],
    tool_choice: { type: 'tool', name: 'decide_hunt' },
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const block = res.content.find(b => b.type === 'tool_use') as Anthropic.ToolUseBlock | undefined;
  const input = (block?.input ?? {}) as { target_index: number | null; tactic: string; thought: string };
  const target =
    input.target_index != null && snap[input.target_index] ? snap[input.target_index].id : undefined;
  return { target, tactic: input.tactic || 'dive', thought: input.thought || 'I hunger.' };
}

// ── the hunt loop ────────────────────────────────────────────────────────────
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const snap = snapshot();
    if (snap.length === 0) {
      conn.reducers.setHawkIntent({ target: undefined, tactic: 'circle', thought: 'An empty sky. I wait.' });
      return;
    }
    const decision = hasKey ? await llmDecision(snap).catch(() => fallbackDecision(snap)) : fallbackDecision(snap);
    conn.reducers.setHawkIntent({ target: decision.target, tactic: decision.tactic, thought: decision.thought });
    const name = decision.target ? (snap.find(s => s.id === decision.target)?.name ?? '?') : '—';
    console.log(`🦅 ${decision.tactic.padEnd(7)} → ${name.padEnd(8)} "${decision.thought}"`);
  } catch (e) {
    console.error('tick error:', (e as Error).message);
  } finally {
    busy = false;
  }
}

setInterval(tick, THINK_MS);
console.log(`🦅 Hawk Agent starting → ${HOST}/${DB}`);
if (!hasKey) {
  console.log('⚠️  ANTHROPIC_API_KEY not set — running with the fallback brain.');
  console.log('   Set your (rotated!) key:  export ANTHROPIC_API_KEY=sk-ant-...  then re-run `npm run agent`.');
}
