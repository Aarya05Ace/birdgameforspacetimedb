// ─────────────────────────────────────────────────────────────────────────────
// birdgame — SpacetimeDB server module  ·  "Murmuration: survive the AI hawk"
//
// The database IS the game engine. It owns:
//   • every player's live transform (player table)
//   • an LLM-driven hawk predator (hawk table; an external agent sets its intent
//     via set_hawk_intent, the deterministic world_tick flies the chase)
//   • a scheduled `world_tick` heartbeat that moves the hawk, computes flock
//     formation/safety, and resolves catches — all server-authoritative.
//
// Survival rule: a lone bird is prey. Birds inside a formation (a flockmate
// within FORMATION_RADIUS) are protected and cannot be caught. Stick together.
// ─────────────────────────────────────────────────────────────────────────────
import { schema, t, table, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// ── Tables ───────────────────────────────────────────────────────────────────
const player = table(
  { name: 'player', public: true },
  {
    identity: t.identity().primaryKey(),
    name: t.option(t.string()),
    x: t.f32(), y: t.f32(), z: t.f32(),
    yaw: t.f32(), pitch: t.f32(), roll: t.f32(),
    hue: t.f32(),
    alive: t.bool(),
    inFormation: t.bool(),  // protected this tick (a flockmate is near)
    flockSize: t.i32(),     // how many birds are clustered with this one (incl self)
    survivalTicks: t.i32(), // ticks survived since last spawn (the score)
    online: t.bool(),
    lastUpdate: t.timestamp(),
  }
);

const hawk = table(
  { name: 'hawk', public: true },
  {
    id: t.u32().primaryKey(),
    x: t.f32(), y: t.f32(), z: t.f32(),
    targetIdentity: t.option(t.identity()), // who the LLM chose to hunt
    tactic: t.string(),                      // 'dive' | 'stalk' | 'circle' | ...
    thought: t.string(),                     // the LLM's live taunt / reasoning
    speed: t.f32(),
    updatedAt: t.timestamp(),
  }
);

const world = table(
  { name: 'world', public: true },
  {
    id: t.u32().primaryKey(),
    tickCount: t.u64(),
    huntActive: t.bool(),
  }
);

// Scheduled "heartbeat" — drives world_tick on a fixed interval.
const tickSchedule = table(
  { name: 'tick_schedule', scheduled: (): any => worldTick },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

// Rolling drama feed: who got caught + the hawk's thought at that moment.
const killFeed = table(
  { name: 'kill_feed', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    victimName: t.string(),
    thought: t.string(),
    at: t.timestamp(),
  }
);

const spacetimedb = schema({ player, hawk, world, tickSchedule, killFeed });
export default spacetimedb;

// ── Tunables ─────────────────────────────────────────────────────────────────
const TICK_DT = 0.1;               // seconds per tick (10 Hz)
const TICK_MICROS = 100_000n;      // 100 ms
const FORMATION_RADIUS = 55;       // flockmate within this distance = protected
const FORMATION_R2 = FORMATION_RADIUS * FORMATION_RADIUS;
const CATCH_RADIUS = 18;           // hawk this close to an unprotected bird = caught
const HAWK_SPEED = 42;             // m/s — faster than a lone stork (hardcore)
const SPAWN_ALT = 180;

// ── Reducers ─────────────────────────────────────────────────────────────────
export const setName = spacetimedb.reducer(
  { name: t.string() },
  (ctx, { name }) => {
    if (!name.trim()) throw new SenderError('Names must not be empty');
    const me = ctx.db.player.identity.find(ctx.sender);
    if (!me) throw new SenderError('Unknown player');
    ctx.db.player.identity.update({ ...me, name: name.trim().slice(0, 24) });
  }
);

export const updateTransform = spacetimedb.reducer(
  { x: t.f32(), y: t.f32(), z: t.f32(), yaw: t.f32(), pitch: t.f32(), roll: t.f32() },
  (ctx, { x, y, z, yaw, pitch, roll }) => {
    const me = ctx.db.player.identity.find(ctx.sender);
    if (!me) return;
    ctx.db.player.identity.update({ ...me, x, y, z, yaw, pitch, roll, lastUpdate: ctx.timestamp });
  }
);

/** Called by the LLM Hawk Agent (a SpacetimeDB client) to set the hawk's plan. */
export const setHawkIntent = spacetimedb.reducer(
  { target: t.option(t.identity()), tactic: t.string(), thought: t.string() },
  (ctx, { target, tactic, thought }) => {
    const h = ctx.db.hawk.id.find(0);
    if (!h) return;
    ctx.db.hawk.id.update({
      ...h,
      targetIdentity: target ?? undefined,
      tactic: tactic.slice(0, 32),
      thought: thought.slice(0, 160),
      updatedAt: ctx.timestamp,
    });
  }
);

/** Bring a caught bird back to life at a fresh spawn. */
export const respawn = spacetimedb.reducer(ctx => {
  const me = ctx.db.player.identity.find(ctx.sender);
  if (!me) return;
  const angle = ctx.random() * Math.PI * 2;
  const dist = Math.sqrt(ctx.random()) * 40;
  ctx.db.player.identity.update({
    ...me,
    alive: true,
    inFormation: false,
    survivalTicks: 0,
    x: Math.cos(angle) * dist,
    y: SPAWN_ALT,
    z: Math.sin(angle) * dist,
  });
});

// ── Scheduled heartbeat: the authoritative hunt ──────────────────────────────
export const worldTick = spacetimedb.reducer(
  { timer: tickSchedule.rowType },
  ctx => {
    const h = ctx.db.hawk.id.find(0);
    if (!h) return;

    const flock = [...ctx.db.player.iter()]
      .filter(p => p.online && p.alive)
      .map(p => ({ p, hex: p.identity.toHexString() }));

    // 1) Move the hawk. Toward the LLM's target if valid, else stalk the flock centroid.
    let target: typeof h | null = null;
    let tHex = '';
    if (h.targetIdentity) {
      const tp = ctx.db.player.identity.find(h.targetIdentity);
      if (tp && tp.online && tp.alive) { target = tp as any; tHex = tp.identity.toHexString(); }
    }
    let dx = 0, dy = 0, dz = 0, spd = HAWK_SPEED * 0.45;
    if (target) {
      dx = target.x - h.x; dy = target.y - h.y; dz = target.z - h.z;
      spd = HAWK_SPEED;
    } else if (flock.length > 0) {
      let cx = 0, cy = 0, cz = 0;
      for (const { p } of flock) { cx += p.x; cy += p.y; cz += p.z; }
      cx /= flock.length; cy /= flock.length; cz /= flock.length;
      dx = cx - h.x; dy = cy - h.y; dz = cz - h.z;
    }
    const len = Math.hypot(dx, dy, dz) || 1;
    const hx = h.x + (dx / len) * spd * TICK_DT;
    const hy = h.y + (dy / len) * spd * TICK_DT;
    const hz = h.z + (dz / len) * spd * TICK_DT;
    ctx.db.hawk.id.update({ ...h, x: hx, y: hy, z: hz, updatedAt: ctx.timestamp });

    // 2) Formation + survival + catch (closest unprotected bird within reach).
    let caughtHex = '';
    let caughtDist = CATCH_RADIUS;
    for (const { p, hex } of flock) {
      let nearby = 0;
      for (const { p: q, hex: qhex } of flock) {
        if (qhex === hex) continue;
        const ax = q.x - p.x, ay = q.y - p.y, az = q.z - p.z;
        if (ax * ax + ay * ay + az * az <= FORMATION_R2) nearby++;
      }
      const inFormation = nearby >= 1;
      ctx.db.player.identity.update({
        ...p,
        inFormation,
        flockSize: nearby + 1,
        survivalTicks: p.survivalTicks + 1,
      });
      if (!inFormation) {
        const d = Math.hypot(p.x - hx, p.y - hy, p.z - hz);
        if (d <= caughtDist) { caughtDist = d; caughtHex = hex; }
      }
    }

    if (caughtHex) {
      const victim = flock.find(f => f.hex === caughtHex)!.p;
      const fresh = ctx.db.player.identity.find(victim.identity);
      if (fresh) ctx.db.player.identity.update({ ...fresh, alive: false, inFormation: false });
      const h2 = ctx.db.hawk.id.find(0);
      if (h2) ctx.db.hawk.id.update({ ...h2, targetIdentity: undefined });
      const name = victim.name ?? caughtHex.substring(0, 6);
      ctx.db.killFeed.insert({ id: 0n, victimName: name, thought: h.thought, at: ctx.timestamp });
    }

    const w = ctx.db.world.id.find(0);
    if (w) ctx.db.world.id.update({ ...w, tickCount: w.tickCount + 1n });
  }
);

// ── Lifecycle ────────────────────────────────────────────────────────────────
export const init = spacetimedb.init(ctx => {
  ctx.db.world.insert({ id: 0, tickCount: 0n, huntActive: true });
  ctx.db.hawk.insert({
    id: 0,
    x: 0, y: SPAWN_ALT + 60, z: 0,
    targetIdentity: undefined,
    tactic: 'circle',
    thought: 'The hawk wheels overhead, choosing its first victim…',
    speed: HAWK_SPEED,
    updatedAt: ctx.timestamp,
  });
  ctx.db.tickSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(TICK_MICROS) });
});

/**
 * Explicitly join the flock as a bird. The game client calls this on connect;
 * the headless Hawk Agent connects but never calls it, so it has no player row
 * (it controls the hawk, it is not prey).
 */
export const joinGame = spacetimedb.reducer(ctx => {
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) {
    ctx.db.player.identity.update({ ...existing, online: true, alive: true });
    return;
  }
  const angle = ctx.random() * Math.PI * 2;
  const dist = Math.sqrt(ctx.random()) * 40;
  ctx.db.player.insert({
    identity: ctx.sender,
    name: undefined,
    x: Math.cos(angle) * dist, y: SPAWN_ALT, z: Math.sin(angle) * dist,
    yaw: angle + Math.PI, pitch: 0, roll: 0,
    hue: ctx.random(),
    alive: true,
    inFormation: false,
    flockSize: 1,
    survivalTicks: 0,
    online: true,
    lastUpdate: ctx.timestamp,
  });
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  // Mark a returning bird online; brand-new connections become birds only when
  // they call joinGame (so the Hawk Agent's connection never spawns a bird).
  const existing = ctx.db.player.identity.find(ctx.sender);
  if (existing) ctx.db.player.identity.update({ ...existing, online: true });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const me = ctx.db.player.identity.find(ctx.sender);
  if (me) ctx.db.player.identity.update({ ...me, online: false });
});
