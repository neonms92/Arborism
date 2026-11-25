// Boot, lobby, main loop. The only file that knows about every module.
// See docs/DESIGN.md 1.3.

import { CFG } from './config.js';
import { World } from './model/world.js';
import { View } from './view/view.js';
import { Hud, describe } from './view/hud.js';
import { Menu } from './view/menu.js';
import { Input } from './input.js';
import { LeaveGuard } from './leave.js';
import { Net } from './net/net.js';
import { encodeSnapshot, Interp } from './net/snapshot.js';
import { NetStats, upCount, upLoss } from './net/stats.js';
import { randomSeed, seedNumbers } from './model/seed.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);

const world = new World();
let view = null;
const menu = new Menu(() => view && view.applySettings(), () => {
  if (sim) { applySeed(); sim.regrow(); } else hud.toast('Only the host can grow a new tree');
});     // also loads saved settings into CFG, before anything reads them
menu.world = world;
// the world seed: one word for the tree, the ground and the yards (model/seed.js). A fresh random word on
// every visit, or ?seed=word. The lobby box and the Tab menu's box edit the same value.
CFG.WORLD_SEED = (q.get('seed') || '').trim().toLowerCase() || randomSeed();
/** Turn the seed word into the generators' numeric seeds, just before a tree grows. */
function applySeed() {
  const n = seedNumbers(CFG.WORLD_SEED);
  if (n) { CFG.TREE_SEED = n.tree; CFG.TERRAIN_SEED = n.terrain; CFG.YARD_SEED = n.yard; }
}
menu.onSeed = () => { $('seed').value = CFG.WORLD_SEED; };
menu.showSeed();
menu.onSkip = () => { if (sim) sim.skipTime(); else hud.toast('Only the host can change the time of day'); };
menu.onChipper = () => { if (sim) sim.chipper.respawn(); else hud.toast('Only the host can respawn the chipper'); };
view = new View($('game'), world);
const hud = new Hud(world);
hud.view = view;                                 // the HUD shows the draw distance when the frame rate has cut it
const input = new Input($('game'));
// Back / swipe-back asks before leaving a game; the game takes no input while it asks
const leaveGuard = new LeaveGuard((open) => { input.active = !open; });
const net = new Net();

let sim = null, interp = null, me = -1, aux = null, room = '', role = '', running = false;
let nextPid = 1, acc = 0, last = performance.now(), inputTimer = 0, inSeq = 0, stats = null;

world.on((ev, info) => {
  if ((ev.t === 'terrain' || ev.t === 'load') && menu.open) menu.showSeed();
  if (ev.t === 'toast' && (ev.to < 0 || ev.to === me)) hud.toast(ev.msg);
  if (ev.t === 'rmpiece' && interp) interp.drop(ev.piece);
  if (ev.t === 'chip' && interp) for (const id of info.gone) interp.drop(id);
});

// ---------- lobby ----------
const msg = (s) => { $('msg').textContent = s; };
const randomRoom = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join('');

async function startHost(online) {
  if (running) return; running = true;
  msg('Starting simulation...');
  const { Sim } = await import('./sim/sim.js');
  CFG.WORLD_SEED = $('seed').value.trim().toLowerCase() || CFG.WORLD_SEED;
  applySeed();
  sim = await Sim.create(world);
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
    if (m.t === 'pi' && Number.isFinite(m.s)) {        // ping: answer at once, with the input loss seen here (net/stats.js)
      if (c.fast?.open) c.fast.send(JSON.stringify({ t: 'po', s: m.s, up: upLoss(c), fps: Math.round(hud.fps), q: Net.queued(c.fast), sk: c.skipped || 0 }));
      c.st = { r: +m.r || 0, l: +m.l || 0, via: typeof m.via === 'string' ? m.via.slice(0, 12) : '' };
      return;
    }
    // inputs arrive unordered: one older than an input already used is dropped, so a late "still climbing" cannot undo a stop
    if (m.t === 'in' && Number.isFinite(m.n) && !upCount(c, m.n, performance.now())) return;
    const i = m.i;
    if (m.t === 'in' && i && i.c && ['mx', 'my', 'yaw', 'pitch', 'sy', 'sp', 'rt', 'lt'].every((k) => Number.isFinite(i[k]))) sim.players.setInput(c.pid, i);
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
  interp = new Interp(); stats = new NetStats();
  net.onHostData = (d) => {
    const now = performance.now();
    stats.packet(typeof d === 'string' ? d.length : d.byteLength, now);
    if (typeof d !== 'string') {
      const buf = d instanceof ArrayBuffer ? d : d.buffer, dv = new DataView(buf);
      const tick = dv.getUint8(0) === 1 ? dv.getUint32(2, true) : -1, stale = tick <= interp.lastTick;
      interp.push(buf);
      if (tick >= 0) stats.snap(tick, now, stale, now - interp.sentAt);
      return;
    }
    const m = JSON.parse(d);
    if (m.t === 'po') { stats.pong(m, now); return; }
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
  leaveGuard.arm();
  document.activeElement?.blur();
}

$('seed').value = CFG.WORLD_SEED;
$('seed').onchange = () => menu.setSeed($('seed').value || randomSeed());
$('bSeed').onclick = () => menu.setSeed(randomSeed());
$('bHost').onclick = () => startHost(true);
$('bSolo').onclick = () => startHost(false);
$('bJoin').onclick = () => startJoin($('code').value);
// the Testing menu: engine tests in workers (docs/TESTS.md); only from the main menu, never during a game
let testing = false;
const openTests = async (headless) => {
  if (running || testing) return;
  testing = true; $('lobby').style.display = 'none';
  const ui = await import('./test/ui.js');
  const back = () => { testing = false; $('lobby').style.display = ''; };
  if (headless) ui.headless(q, back);
  else { const t = ui.openTesting(back); if (q.get('view')) t.viewDefault(q.get('view')); }
};
$('bTest').onclick = () => openTests(false);
if (q.has('test')) openTests(true);
else if (q.has('view')) openTests(false);         // ?view=FM-10: straight to that test's default point
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
const hostSource = { pose: (id) => sim.pose(id), get flex() { return sim.structure.flex; } };
const HELP = '{move} move / climb   {look} look   hold {interact}: spur in / move the lanyard (also grabs the rope tail)   hold {drop}: let go of the tree   {jump} jump   ' +
  '{rig}: hang the block, then tie the rope to the wood looked at, or untie at the knot   {punch}: punch the wood (press again and again to push harder)   ' +
  '{raise} plant the saw on the wood you are looking at, then {look} pivots the bar and {throttle} presses it in   ' +
  'on the rope tail: {throttle} ease, {raise} haul, {wraps} wraps   {menu} settings   {respawn} respawn';
const TOUCH_HELP = '{move} move / climb   {look} look   the big button does what the prompt says (hold it to spur in or move the lanyard)   ' +
  'hold {drop} to let go of the tree   {rig}, {punch} and {raise} appear when they can be used; with the saw planted, {look} pivots the bar and hold {throttle} to press it in   ' +
  'on the rope tail: the slider hauls (up) and eases (down), {wraps}   {menu} settings   {respawn} respawn';
let helpDevice = '';

function frame(now) {
  requestAnimationFrame(frame);
  if (testing) { last = now; return; }             // the Testing menu covers the game; do not draw behind it
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!input.active) {
    lobbyPad(); input.poll(dt); input.touch.sync(null, false);
    if (helpDevice !== input.device) { helpDevice = input.device; $('help').textContent = (helpDevice === 'pad' ? 'Controller: ' : helpDevice === 'touch' ? 'Touch: ' : 'Keyboard and mouse: ') + describe(helpDevice === 'touch' ? TOUCH_HELP : HELP, helpDevice);
      const pad = helpDevice === 'pad';
      $('bHost').textContent = pad ? 'Host (A)' : 'Host'; $('bSolo').textContent = pad ? 'Solo (Y)' : 'Solo'; $('bJoin').textContent = pad ? 'Join (X)' : 'Join';
    }
    view.update(dt, { pose: () => null }, null, -1, input.state); return;
  }

  const mine = aux && aux.pl.find((p) => p.id === me);
  input.sawOut = !!(mine && mine.saw);
  if (menu.open) { input.mouse.l = input.mouse.r = false; }
  const inp = input.poll(dt);
  if (input.menuToggled) { input.menuToggled = false; menu.toggle(); }
  input.menuOpen = menu.open;                      // the menu's Close button shuts it too

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
    if (inputTimer >= 1 / CFG.INPUT_HZ) { inputTimer = 0; net.sendFast({ t: 'in', n: ++inSeq, i: inp }); }
    const pm = stats.ping(performance.now()); if (pm) net.sendFast(pm, true);
    stats.routeCheck(performance.now(), () => Net.route(net.fast));
  }

  view.update(dt, sim ? hostSource : interp, aux, me, inp);
  let info = role === 'solo' ? 'solo' : role === 'host' ? `HOST  room ${room}  (${net.clients.size} joined)` : `joined ${room}  ${stats.short()}`;
  if (role === 'host') for (const c of net.clients.values()) if (c.st) info += `  P${c.pid} ${c.st.r} ms ${Math.round(Math.max(c.st.l, upLoss(c)) * 100)}%${c.st.via === 'relay' ? ' RELAY' : ''}`;
  hud.net(role === 'client' && CFG.NET_STATS ? stats.lines(performance.now()) : null);
  hud.update(dt, aux, me, info, input.device);
  input.touch.sync(mine, !menu.open);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  // rAF stops in a hidden tab, so the host's sim (and everyone's game) pauses. See DESIGN.md risk 3 / task P2-8.
  if (sim && net.clients.size && !document.hidden) hud.toast('Host tab was hidden: the game was paused for everyone');
});
if (room) localStorage.setItem('arb-room', room);

// handy for poking at things from the console
window.arb = { CFG, world, view, menu, net, get sim() { return sim; }, get aux() { return aux; }, get me() { return me; }, input };
