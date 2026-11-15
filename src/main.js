// Boot, lobby, main loop. The only file that knows about every module.
// See docs/DESIGN.md 1.3.

import { CFG } from './config.js';
import { World } from './model/world.js';
import { View } from './view/view.js';
import { Hud } from './view/hud.js';
import { Input } from './input.js';
import { Net } from './net/net.js';
import { encodeSnapshot, Interp } from './net/snapshot.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);

const world = new World();
const view = new View($('game'), world);
const hud = new Hud(world);
const input = new Input($('game'));
const net = new Net();

let sim = null, interp = null, me = -1, aux = null, room = '', role = '', running = false;
let nextPid = 1, acc = 0, last = performance.now(), inputTimer = 0;

world.on((ev) => {
  if (ev.t === 'toast' && (ev.to < 0 || ev.to === me)) hud.toast(ev.msg);
  if (ev.t === 'rmpiece' && interp) interp.drop(ev.piece);
});

// ---------- lobby ----------
const msg = (s) => { $('msg').textContent = s; };
const randomRoom = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join('');

async function startHost(online) {
  if (running) return; running = true;
  msg('Starting simulation...');
  const { Sim } = await import('./sim/sim.js');
  sim = await Sim.create(world, +(q.get('seed') || 7));
  me = nextPid++;
  sim.players.add(me, 'host');
  role = 'solo';
  if (online) {
    room = (q.get('host') || randomRoom()).toUpperCase();
    msg('Registering room...');
    try {
      wireHost();
      await net.host(room);
      role = 'host';
    } catch (e) {
      hud.toast('Could not reach the signaling server - playing solo (' + (e.type || e.message) + ')');
    }
  }
  begin();
}

function wireHost() {
  net.onJoin = (key, c) => {
    flushEvents();                               // existing clients get everything up to now
    c.pid = nextPid++;
    sim.players.add(c.pid, 'p' + c.pid);
    flushEvents();                               // ...including the new player
    net.sendRel(c, { t: 'welcome', pid: c.pid, tick: sim.tick, world: world.serialize() });
    c.ready = true;
    hud.toast(`Player ${c.pid} joined`);
  };
  net.onLeave = (key, c) => { if (c.pid > 0) { sim.players.remove(c.pid); hud.toast(`Player ${c.pid} left`); } };
  net.onClientData = (key, c, d) => {
    if (typeof d !== 'string' || c.pid < 0) return;
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'in' && m.i && m.i.c && Array.isArray(m.i.o) && Array.isArray(m.i.d)) sim.players.setInput(c.pid, m.i);
  };
}

function flushEvents() {
  if (!sim.outbox.length) return;
  if (net.clients.size) net.broadcastRel({ t: 'ev', evs: sim.outbox });
  sim.outbox = [];
}

async function startJoin(code) {
  if (running) return;
  room = code.toUpperCase().trim();
  if (room.length < 3) { msg('Enter the host\'s room code'); return; }
  running = true; msg('Connecting to ' + room + '...');
  interp = new Interp();
  net.onHostData = (d) => {
    if (typeof d !== 'string') { interp.push(d instanceof ArrayBuffer ? d : d.buffer); return; }
    const m = JSON.parse(d);
    if (m.t === 'welcome') { world.load(m.world); me = m.pid; role = 'client'; begin(); }
    else if (m.t === 'ev') for (const ev of m.evs) world.apply(ev);
    else if (m.t === 'aux') { if (!aux || m.tick > aux.tick) aux = m; }
  };
  net.onLost = () => hud.toast('Lost connection to the host');
  try { await net.join(room); msg('Connected, waiting for the world...'); }
  catch (e) {
    running = false;
    msg('Could not join: ' + (e.type === 'peer-unavailable' ? 'no such room' : (e.type || e.message)));
  }
}

function begin() {
  $('lobby').style.display = 'none';
  input.active = true;
  document.activeElement?.blur();
}

$('bHost').onclick = () => startHost(true);
$('bSolo').onclick = () => startHost(false);
$('bJoin').onclick = () => startJoin($('code').value);
$('code').value = (q.get('join') || localStorage.getItem('arb-room') || '').toUpperCase();
if (q.has('solo')) startHost(false);
else if (q.has('host')) startHost(true);
else if (q.has('join')) startJoin(q.get('join'));

// gamepad in the lobby: A host, Y solo, X join
let lobbyPrev = [];
function lobbyPad() {
  const pad = [...(navigator.getGamepads?.() || [])].find((p) => p && p.connected);
  if (!pad) return;
  const hit = (i) => pad.buttons[i]?.pressed && !lobbyPrev[i];
  if (hit(0)) startHost(true); else if (hit(3)) startHost(false); else if (hit(2)) startJoin($('code').value);
  lobbyPrev = pad.buttons.map((b) => b.pressed);
}

// ---------- main loop ----------
const hostSource = { pose: (id) => sim.pose(id) };
const stressOf = (secId) => {
  if (sim) { const s = world.sections.get(secId); return s ? Array.from(s.stress, (v) => v / CFG.MOR * 100) : null; }
  return aux && aux.watch ? aux.watch[secId] : null;
};

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!input.active) { lobbyPad(); view.update(dt, { pose: () => null }, null, -1, input.state); return; }

  const mine = aux && aux.pl.find((p) => p.id === me);
  input.precise = !!(mine && mine.saw);
  const inp = input.poll(dt);
  if (input.overlayToggled) { input.overlayToggled = false; view.setOverlay(!view.overlay); }

  if (sim) {
    sim.players.setInput(me, inp);
    acc += dt;
    let n = 0;
    while (acc >= CFG.TICK && n++ < 4) {
      acc -= CFG.TICK;
      sim.step();
      if (net.clients.size) {
        if (sim.tick % CFG.SNAP_EVERY === 0) net.broadcastFast(encodeSnapshot(sim, sim.tick % CFG.FULL_EVERY === 0));
        if (sim.tick % CFG.AUX_EVERY === 0) net.broadcastFast(sim.aux());
      }
    }
    if (acc > CFG.TICK * 4) acc = 0;
    flushEvents();
    aux = sim.aux();
  } else {
    interp.advance();
    inputTimer += dt;
    if (inputTimer >= 1 / CFG.INPUT_HZ) { inputTimer = 0; net.sendFast({ t: 'in', i: inp }); }
  }

  if (aux && view.overlay && (!sim || sim.tick % 6 === 0)) {
    view.util.clear();
    for (let i = 0; i < aux.util.length; i += 2) view.util.set(aux.util[i], aux.util[i + 1] / 100);
    view.paintUtil();
  }
  view.update(dt, sim ? hostSource : interp, aux, me, inp);
  const info = role === 'solo' ? 'solo' : role === 'host' ? `HOST  room ${room}  (${net.clients.size} joined)` : `joined ${room}`;
  hud.update(dt, aux, me, info + (document.hidden ? '' : ''), stressOf);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  if (sim && net.clients.size && document.hidden) console.warn('Host tab hidden: the simulation pauses for everyone.');
});
if (room) localStorage.setItem('arb-room', room);

// handy for poking at things from the console
window.arb = { CFG, world, view, net, get sim() { return sim; }, get aux() { return aux; }, get me() { return me; }, input };
