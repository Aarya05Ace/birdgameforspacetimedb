// ─────────────────────────────────────────────────────────────────────────────
// Multiplayer.js — shared flock + LLM hawk over SpacetimeDB  (ORIGINAL, our layer)
//
// Turns single-player birdybird into "Murmuration": every player's stork is
// synced through the `player` table, an LLM-driven hawk (the `hawk` table, set
// by agent/hawk.ts) hunts the flock, and survival is server-authoritative — a
// lone bird is prey, a bird in formation is protected. This module renders all
// of that and drives the local effects (drafting boost, death/respawn).
//
// SpacetimeDB is the whole backend: tables `player` / `hawk` / `world` /
// `kill_feed`, reducers `join_game` / `update_transform` / `respawn`, and a
// scheduled `world_tick` that flies the hawk and resolves catches.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { DbConnection, tables } from '../module_bindings';

const params = new URLSearchParams(location.search);
const HOST = params.get('mp') === 'cloud' ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000';
const DB_NAME = params.get('db') || (params.get('mp') === 'cloud' ? 'birdgame-murmuration' : 'birdgame');
const FRESH = params.get('fresh') === '1';
const TOKEN_KEY = `birdybird::${HOST}::${DB_NAME}::token`;
const SEND_HZ = 12;

function forwardFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

export class Multiplayer {
  constructor(scene) {
    this.scene = scene;
    this.conn = null;
    this.identity = null;
    this.myHex = null;
    this.connected = false;

    this.remotes = new Map(); // hex -> { group, mixer, target, init, hue }
    this._proto = null;
    this._protoAnim = null;
    this._sendAccum = 0;

    // local survival state
    this.localAlive = true;
    this.localInFormation = false;
    this.localSurvival = 0;
    this._prevAlive = true;
    this._respawnTo = null;

    // hawk
    this._hawk = { target: { x: 0, y: 240, z: 0 }, group: null, prev: new THREE.Vector3(0, 240, 0), thought: '' };

    this._ui = this._buildUI();
    this._loadStork();
    this._connect();
  }

  // ── connection ───────────────────────────────────────────────────────────
  _loadStork() {
    new GLTFLoader().load('models/Stork.glb', (gltf) => {
      this._proto = gltf.scene;
      this._protoAnim = gltf.animations?.[0] || null;
      for (const hex of this.remotes.keys()) this._ensureMesh(hex);
      this._ensureHawkMesh();
    }, undefined, (e) => console.warn('[mp] stork load failed', e));
  }

  _connect() {
    this.conn = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .withToken(FRESH ? undefined : localStorage.getItem(TOKEN_KEY) || undefined)
      .onConnect((conn, identity, token) => {
        if (!FRESH) localStorage.setItem(TOKEN_KEY, token);
        this.identity = identity;
        this.myHex = identity.toHexString();
        this.connected = true;
        console.log('[mp] connected', this.myHex.slice(0, 8));
        try { conn.reducers.joinGame(); } catch (e) { console.warn('[mp] joinGame', e); }
        conn.subscriptionBuilder()
          .onApplied(() => console.log('[mp] subscribed'))
          .subscribe([tables.player, tables.hawk, tables.world, tables.killFeed]);
      })
      .onConnectError((_c, err) => { console.warn('[mp] connect error', err); this._setStatus('offline'); })
      .onDisconnect(() => { this.connected = false; this._setStatus('offline'); })
      .build();

    this.conn.db.player.onInsert((_c, r) => this._onPlayer(r));
    this.conn.db.player.onUpdate((_c, _o, r) => this._onPlayer(r));
    this.conn.db.player.onDelete((_c, r) => this._remove(r.identity.toHexString()));
    this.conn.db.hawk.onInsert((_c, r) => this._onHawk(r));
    this.conn.db.hawk.onUpdate((_c, _o, r) => this._onHawk(r));
    this.conn.db.killFeed.onInsert((_c, r) => this._onKill(r));
  }

  // ── row handlers ──────────────────────────────────────────────────────────
  _onPlayer(row) {
    const hex = row.identity.toHexString();
    if (hex === this.myHex) {
      this.localInFormation = row.inFormation;
      this.localSurvival = row.survivalTicks;
      this.localAlive = row.alive;
      if (row.alive && !this._prevAlive) this._respawnTo = { x: row.x, y: row.y, z: row.z }; // just respawned
      this._prevAlive = row.alive;
      this._setStatus();
      this._renderDeath();
      return;
    }
    if (!row.online || !row.alive) { this._remove(hex); return; }
    const target = { x: row.x, y: row.y, z: row.z, yaw: row.yaw, pitch: row.pitch, roll: row.roll };
    const r = this.remotes.get(hex);
    if (!r) {
      this.remotes.set(hex, { group: null, mixer: null, target, init: false, hue: row.hue });
      this._ensureMesh(hex);
    } else r.target = target;
  }

  _onHawk(row) {
    this._hawk.target = { x: row.x, y: row.y, z: row.z };
    if (row.thought && row.thought !== this._hawk.thought) {
      this._hawk.thought = row.thought;
      this._ui.thought.textContent = '🦅 ' + row.thought;
      this._ui.thought.style.opacity = '1';
    }
    this._ensureHawkMesh();
  }

  _onKill(row) {
    const line = document.createElement('div');
    line.textContent = `🩸 ${row.victimName} was taken — “${row.thought}”`;
    line.style.cssText = 'margin:2px 0;opacity:0;transition:opacity .4s';
    this._ui.feed.prepend(line);
    requestAnimationFrame(() => { line.style.opacity = '0.92'; });
    while (this._ui.feed.children.length > 4) this._ui.feed.removeChild(this._ui.feed.lastChild);
  }

  // ── meshes ──────────────────────────────────────────────────────────────────
  _ensureMesh(hex) {
    const r = this.remotes.get(hex);
    if (!r || r.group || !this._proto) return;
    const g = skeletonClone(this._proto);
    g.scale.setScalar(0.04);
    g.traverse((c) => { if (c.isMesh && c.material) { c.material = c.material.clone(); if (c.material.color) c.material.color.setHSL(r.hue ?? 0.1, 0.45, 0.72); c.castShadow = c.receiveShadow = false; } });
    this.scene.add(g);
    r.group = g;
    if (this._protoAnim) { r.mixer = new THREE.AnimationMixer(g); r.mixer.clipAction(this._protoAnim).play(); }
  }

  _ensureHawkMesh() {
    if (this._hawk.group || !this._proto) return;
    const g = skeletonClone(this._proto);
    g.scale.setScalar(0.075); // bigger, menacing
    g.traverse((c) => { if (c.isMesh && c.material) { c.material = c.material.clone(); if (c.material.color) c.material.color.setHSL(0.02, 0.6, 0.22); c.castShadow = c.receiveShadow = false; } });
    g.position.set(this._hawk.target.x, this._hawk.target.y, this._hawk.target.z);
    this.scene.add(g);
    this._hawk.group = g;
    if (this._protoAnim) { this._hawk.mixer = new THREE.AnimationMixer(g); this._hawk.mixer.clipAction(this._protoAnim).play(); }
  }

  _remove(hex) {
    const r = this.remotes.get(hex);
    if (!r) return;
    if (r.group) { this.scene.remove(r.group); r.group.traverse((c) => { if (c.isMesh) { c.geometry?.dispose?.(); if (Array.isArray(c.material)) c.material.forEach(m => m.dispose()); else c.material?.dispose?.(); } }); }
    this.remotes.delete(hex);
  }

  // ── per-frame ────────────────────────────────────────────────────────────────
  /** Throttled broadcast of our transform. */
  pushLocal(flightState, dt) {
    if (!this.connected || !this.conn) return;
    this._sendAccum += dt;
    if (this._sendAccum < 1 / SEND_HZ) return;
    this._sendAccum = 0;
    const p = flightState.position;
    try {
      this.conn.reducers.updateTransform({ x: p.x, y: p.y, z: p.z, yaw: flightState.yaw, pitch: flightState.pitch, roll: flightState.roll });
    } catch { /* not ready */ }
  }

  /** Interpolate remotes + hawk, and apply local effects (boost, respawn snap). */
  update(dt, flightState) {
    const k = 1 - Math.exp(-9 * dt);

    // remotes
    for (const r of this.remotes.values()) {
      if (!r.group) continue;
      const t = r.target;
      const d = new THREE.Vector3(t.x, t.y, t.z);
      if (!r.init) { r.group.position.copy(d); r.init = true; } else r.group.position.lerp(d, k);
      const f = forwardFromAngles(t.yaw, t.pitch);
      const look = new THREE.Object3D(); look.position.copy(r.group.position); look.lookAt(r.group.position.clone().add(f)); look.rotateZ(-t.roll);
      r.group.quaternion.slerp(look.quaternion, k);
      r.mixer?.update(dt);
    }

    // hawk — interpolate + face its motion
    if (this._hawk.group) {
      const g = this._hawk.group;
      const d = new THREE.Vector3(this._hawk.target.x, this._hawk.target.y, this._hawk.target.z);
      const vel = d.clone().sub(g.position);
      g.position.lerp(d, 1 - Math.exp(-7 * dt));
      if (vel.lengthSq() > 0.02) { const look = new THREE.Object3D(); look.position.copy(g.position); look.lookAt(g.position.clone().add(vel)); g.quaternion.slerp(look.quaternion, k); }
      this._hawk.mixer?.update(dt * 1.6); // faster wingbeat
    }

    // local effects
    if (flightState) {
      if (this._respawnTo) {
        flightState.position.set(this._respawnTo.x, this._respawnTo.y, this._respawnTo.z);
        flightState.velocity.set(-Math.sin(flightState.yaw) * 16, 0, -Math.cos(flightState.yaw) * 16);
        flightState.altitude = this._respawnTo.y;
        this._respawnTo = null;
      }
      // Drafting boost: protected birds get a gentle speed lift (clamped).
      if (this.localAlive && this.localInFormation) {
        const sp = flightState.velocity.length();
        if (sp > 1 && sp < 36) flightState.velocity.multiplyScalar(1 + 0.3 * dt);
      }
      // fade the thought ticker
      if (this._ui.thought.style.opacity !== '0') {
        this._thoughtFade = (this._thoughtFade || 0) + dt;
        if (this._thoughtFade > 6) { this._ui.thought.style.opacity = '0'; this._thoughtFade = 0; }
      }
    }
  }

  // ── UI ───────────────────────────────────────────────────────────────────────
  _buildUI() {
    const css = (el, s) => { el.style.cssText = s; return el; };
    const base = 'font:600 13px system-ui,sans-serif;color:#eaf2f8;pointer-events:none;z-index:60;';

    const status = css(document.createElement('div'), base +
      'position:fixed;top:10px;right:12px;padding:7px 13px;border-radius:20px;background:rgba(8,14,20,.55);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;gap:8px;');
    status.innerHTML = '<span class="mp-dot" style="width:8px;height:8px;border-radius:50%;background:#888"></span><span class="mp-txt">connecting…</span>';

    const thought = css(document.createElement('div'), base +
      'position:fixed;top:64px;left:50%;transform:translateX(-50%);max-width:70vw;text-align:center;padding:6px 14px;border-radius:14px;background:rgba(40,8,8,.55);backdrop-filter:blur(8px);border:1px solid rgba(255,80,80,.25);color:#ffd9d9;font-weight:600;font-style:italic;opacity:0;transition:opacity .5s;');

    const feed = css(document.createElement('div'), base +
      'position:fixed;bottom:12px;left:12px;max-width:46vw;font-size:12px;text-shadow:0 1px 3px #000;');

    const death = css(document.createElement('div'), base.replace('pointer-events:none', 'pointer-events:none') +
      'position:fixed;inset:0;display:none;place-items:center;background:rgba(20,0,0,.45);backdrop-filter:blur(3px);');
    death.innerHTML =
      '<div style="text-align:center;pointer-events:auto">' +
      '<div style="font-size:42px;font-weight:800;letter-spacing:2px;color:#ff5a5a;text-shadow:0 2px 12px #000">CAUGHT</div>' +
      '<div style="margin:6px 0 16px;opacity:.85">The hawk got you. Fly with the flock to stay safe.</div>' +
      '<button class="mp-respawn" style="pointer-events:auto;cursor:pointer;font:700 16px system-ui;color:#fff;background:#2563eb;border:none;border-radius:10px;padding:10px 24px">Respawn</button>' +
      '</div>';

    for (const el of [status, thought, feed, death]) document.body.appendChild(el);
    death.querySelector('.mp-respawn').addEventListener('click', () => { try { this.conn?.reducers.respawn(); } catch (e) { console.warn(e); } });

    return { status, thought, feed, death,
      dot: status.querySelector('.mp-dot'), txt: status.querySelector('.mp-txt') };
  }

  _setStatus(state) {
    if (!this._ui) return;
    if (state === 'offline') { this._ui.dot.style.background = '#ef4444'; this._ui.txt.textContent = 'offline'; return; }
    const others = this.remotes.size;
    if (!this.localAlive) { this._ui.dot.style.background = '#ef4444'; this._ui.txt.textContent = `caught · ${others + 1} in sky`; return; }
    const safe = this.localInFormation;
    this._ui.dot.style.background = safe ? '#4ade80' : '#f59e0b';
    this._ui.dot.style.boxShadow = `0 0 8px ${safe ? '#4ade80' : '#f59e0b'}`;
    const secs = Math.floor(this.localSurvival / 10);
    this._ui.txt.textContent = `${safe ? '🛡 PROTECTED' : '⚠ EXPOSED'} · ${secs}s · ${others + 1} birds`;
  }

  _renderDeath() {
    if (!this._ui) return;
    this._ui.death.style.display = this.localAlive ? 'none' : 'grid';
  }
}
