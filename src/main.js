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
import { ClimbPredict } from './net/predict.js';
import { randomSeed, seedNumbers } from './model/seed.js';
import { cleanName, cleanColor, playerName } from './model/world.js';
import { LinePoses } from './model/lines.js';
import { Stage } from './view/stage.js';
import { StickerBook, StickerUI } from './stickerui.js';

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
// the Tab menu's buttons that act for this player go to the host as presses, like any other (sim/players.js)
menu.onChipper = () => { input.state.c.buyChip++; };
menu.onRespawn = () => { input.state.c.respawn++; };
menu.onBin = () => { input.state.c.buyBin = (input.state.c.buyBin || 0) + 1; };   // the host buys it: joined players can too
view = new View($('game'), world);
const hud = new Hud(world);
hud.view = view;                                 // the HUD shows the draw distance when the frame rate has cut it
const input = new Input($('game'));
// Back / swipe-back asks before leaving a game; the game takes no input while it asks
const leaveGuard = new LeaveGuard((open) => { input.active = !open; });
const net = new Net();
// you, drawn on the start screen and in the sticker dialog; your stickers, kept in this browser (D105)
const stage = new Stage();
$('lobbyAv').appendChild(stage.canvas);
const book = new StickerBook();
const stk = new StickerUI(book, stage);

let sim = null, interp = null, me = -1, aux = null, room = '', role = '', running = false;
// a joined player's copy of the power lines' points, as the host last sent them (aux.ln); kept for taking over (D104)
const linePoses = new LinePoses(), lineOf = (i) => linePoses.get(i);
world.on((ev) => { if (ev.t === 'lines' || ev.t === 'reset' || ev.t === 'load') linePoses.clear(); });
let lastHeard = 0;                                // when anything last came from the host (a client)
const reserved = new Set();                       // players kept for whoever comes back after a handover
let nextPid = 1, acc = 0, last = performance.now(), inputTimer = 0, inSeq = 0, stats = null, predict = null;

world.on((ev, info) => {
  if ((ev.t === 'terrain' || ev.t === 'load') && menu.open) menu.showSeed();
  if (ev.t === 'toast' && (ev.to < 0 || ev.to === me)) hud.toast(ev.msg);
  if (ev.t === 'rmpiece' && interp) interp.drop(ev.piece);
  if (ev.t === 'chip' && interp) for (const id of info.gone) interp.drop(id);
  if (ev.t === 'award' && Array.isArray(ev.to) && ev.to.includes(me)) { const line = book.award(ev); if (line) hud.toast(line); }   // the players who earned it (sim/awards.js)
});

// ---------- lobby ----------
// name and shirt colour: chosen in the lobby, remembered in this browser, sent to the host (players.setLook)
const PALETTE = [0xe8a23a, 0x3a9be8, 0xd94f6a, 0x62c462, 0xb07be0, 0xe0d24a];
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
function look() {
  const c = cleanColor(parseInt(($('pcolor').value || '').slice(1), 16));
  return { name: cleanName($('pname').value), color: c, st: book.wire() };
}
/** Name, shirt and stickers changed: show them on the start screen, and tell the host when in a game. */
function sendLook() {
  const l = look();
  stage.look(l.name || 'You', l.color); stage.stickers(l.st);
  if (sim && me > 0) sim.players.setLook(me, l.name, l.color, l.st);
  else if (role === 'client') net.sendRel(net, { t: 'me', ...l });
}
book.onChange = () => { sendLook(); stk.refresh(); };
{
  let n = '', c = -1;
  try { n = localStorage.getItem('arb-name') || ''; c = cleanColor(parseInt(localStorage.getItem('arb-color'), 10)); } catch { /* storage blocked */ }
  if (c < 0) c = PALETTE[Math.random() * PALETTE.length | 0];
  $('pname').maxLength = CFG.PLAYER_NAME_MAX;
  $('pname').value = n; $('pcolor').value = hex(c);
  const save = () => { const l = look(); try { localStorage.setItem('arb-name', l.name); localStorage.setItem('arb-color', String(l.color)); } catch { /* storage blocked */ } };
  $('pname').onchange = save; $('pcolor').oninput = () => { save(); sendLook(); }; save();
  $('pname').oninput = () => sendLook();          // the start-screen you answers as you type
  sendLook();
}
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
  sim.players.add(me, look().name, look().color, look().st);
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
    // after a handover (D104) a player who was here before gets their own climber back
    const back = c.meta && Number.isInteger(c.meta.pid) && reserved.has(c.meta.pid) ? c.meta.pid : -1;
    if (back > 0) { c.pid = back; reserved.delete(back); c.named = true; }
    else { c.pid = nextPid++; sim.players.add(c.pid, ''); }   // name and colour follow in their 'me' message
    flushEvents();                               // ...including the new player
    net.sendRel(c, { t: 'welcome', pid: c.pid, tick: sim.tick, world: world.serialize() });
    c.ready = true;
  };
  net.onLeave = (key, c) => { if (c.pid > 0 && ![...net.clients.values()].some((o) => o !== c && o.pid === c.pid)) { const n = playerName(world, c.pid); sim.players.remove(c.pid); hud.toast(`${n} left`); } };
  net.onClientData = (key, c, d) => {
    if (typeof d !== 'string' || c.pid < 0) return;
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'pi' && Number.isFinite(m.s)) {        // ping: answer at once, with the input loss seen here (net/stats.js)
      if (c.fast?.open) c.fast.send(JSON.stringify({ t: 'po', s: m.s, up: upLoss(c), fps: Math.round(hud.fps), q: Net.queued(c.fast), sk: c.skipped || 0 }));
      c.st = { r: +m.r || 0, l: +m.l || 0, via: typeof m.via === 'string' ? m.via.slice(0, 12) : '' };
      return;
    }
    if (m.t === 'me') {                                // the joiner's lobby name and shirt colour (cleaned in players.setLook)
      sim.players.setLook(c.pid, m.name, m.color, m.st);
      if (!c.named) { c.named = true; hud.toast(`${playerName(world, c.pid)} joined`); }
      return;
    }
    // inputs arrive unordered: one older than an input already used is dropped, so a late "still climbing" cannot undo a stop
    if (m.t === 'in' && Number.isFinite(m.n) && !upCount(c, m.n, performance.now())) return;
    const i = m.i;
    if (m.t === 'in' && i && i.c && ['mx', 'my', 'yaw', 'pitch', 'sy', 'sp', 'rt', 'lt'].every((k) => Number.isFinite(i[k]))) sim.players.setInput(c.pid, i, Number.isFinite(m.n) ? m.n : undefined);
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
  wireClient();
  try { await joinEither(20000); msg('Connected, waiting for the world...'); }
  catch (e) {
    running = false;
    msg('Could not join: ' + (e.type === 'peer-unavailable' ? 'no such room' : (e.type || e.message)));
  }
}

/** Join the room, or the id a handed-over game moved to while the old one was still held (D104). */
async function joinEither(ms, meta, still = () => true) {
  try { await net.join(room, false, meta, ms); }
  catch (e) { if (!still()) throw e; net.close(); wireClient(); await net.join(room, true, meta, ms); }
}

function wireClient() {
  interp = new Interp(); stats = new NetStats(); predict = new ClimbPredict(world);
  lastHeard = performance.now();
  net.onHostData = (d) => {
    const now = performance.now(); lastHeard = now;
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
    if (m.t === 'welcome') { if (sim || role === 'taking') return; world.load(m.world); me = m.pid; role = 'client'; aux = null; net.sendRel(net, { t: 'me', ...look() }); handover.done(); begin(); }
    else if (m.t === 'ev') for (const ev of m.evs) world.apply(ev);
    else if (m.t === 'aux') { if (!aux || m.tick > aux.tick) aux = m; linePoses.take(m.ln); }
  };
  net.onLost = () => { if (role === 'client') handover.lost(); };
}

// ---------- the host has gone (D104) ----------
// Every player is offered "Continue as host"; meanwhile they keep trying to rejoin, so whoever takes over
// first is found by the rest. The one who takes over builds the simulation from their copy of the world
// (sim/resume.js) and registers the same room code, or its "-2" id while the signaling server still holds
// the old one.
const handover = {
  busy: false, tries: 0, timer: 0, gen: 0,
  lost() {
    if (this.busy) return;
    this.busy = true; this.tries = 0; role = 'lost';
    this.keep = { poses: lastPoses(), aux, lines: linePoses };          // what this player saw last, for taking over
    input.active = false; document.exitPointerLock?.();
    this.show('The host has left the game. Someone can carry on as the host: everyone else rejoins them.', true);
    this.timer = setTimeout(() => this.rejoin(), 1500);
  },
  show(text, canTake) {
    $('handover').style.display = 'flex'; $('hmsg').textContent = text; $('bTake').style.display = canTake ? '' : 'none';
  },
  done() { clearTimeout(this.timer); this.busy = false; $('handover').style.display = 'none'; },
  async rejoin() {
    if (!this.busy || role !== 'lost') return;
    if (++this.tries > 15) { this.show('Nobody took over. Back to the main menu to start or join a game.', true); $('bMenu').style.display = ''; return; }
    $('hmsg').textContent = `The host has left. Looking for whoever carries on (try ${this.tries})...`;
    const gen = this.gen, still = () => role === 'lost' && gen === this.gen;   // taking over cancels a try in flight
    net.close(); wireClient();
    try { await joinEither(10000, { pid: me }, still); }
    catch { if (still()) this.timer = setTimeout(() => this.rejoin(), 2000); }
  },
  async take() {
    if (role !== 'lost') return;
    clearTimeout(this.timer); role = 'taking'; this.gen++;
    this.show('Rebuilding the world here...', false);
    net.close();
    const { Sim } = await import('./sim/sim.js'), { resume } = await import('./sim/resume.js');
    const s = await Sim.create(world, { tree: false, terrain: !!world.terrain });
    resume(s, this.keep);
    sim = s; interp = null; predict = null;
    nextPid = Math.max(me, ...world.players.keys()) + 1;
    reserved.clear(); for (const id of world.players.keys()) if (id !== me) reserved.add(id);
    // whoever has not come back in a minute is gone
    setTimeout(() => { for (const id of [...reserved]) { reserved.delete(id); sim.players.remove(id); } }, 60000);
    wireHost();
    try { await net.host(room); }
    catch (e) {
      try { net.close(); await net.host(room, true); }
      catch (e2) {
        // someone else took over first: be their player instead
        sim = null; role = 'lost'; this.gen++; this.show('Someone else is taking over. Joining them...', false); this.rejoin(); return;
      }
    }
    role = 'host'; acc = 0;
    this.done(); begin();
    hud.toast(`You are the host now. Room ${room}`);
  },
};
$('bTake').onclick = () => handover.take();
$('bMenu').onclick = () => location.reload();

/** The newest transform of every body this client has seen (taking over starts from these, at rest). */
function lastPoses() {
  const out = new Map(); if (!interp) return out;
  for (const [id, b] of interp.bodies) if (b.length) { const s = b[b.length - 1]; out.set(id, { p: { ...s.p }, q: { ...s.q } }); }
  return out;
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
const hostSource = { pose: (id) => sim.pose(id), get flex() { return sim.structure.flex; }, line: (i) => sim.lines.nodes(i) };
const HELP = '{move} move / climb   {look} look   hold {interact}: spur in / move the lanyard (also grabs the rope tail)   hold {drop}: let go of the tree   {jump} jump   ' +
  '{rig}: hang the block, then tie the rope to the wood looked at, or untie at the knot   {punch}: punch the wood (press again and again to push harder)   ' +
  '{raise} plant the saw on the wood you are looking at, then {look} pivots the bar and {throttle} presses it in   ' +
  'salad rack on the chipper: {interact} takes a tube salad, {eat} eats it, {interact} on another player gives it (heals, even when DOWN)   ' +
  'on the rope tail: {throttle} ease, {raise} haul, {wraps} wraps   {menu} settings (Respawn player is in there)';
const TOUCH_HELP = '{move} move / climb   {look} look   the big button does what the prompt says (hold it to spur in or move the lanyard)   ' +
  'hold {drop} to let go of the tree   {rig}, {punch} and {raise} appear when they can be used; with the saw planted, {look} pivots the bar and hold {throttle} to press it in   ' +
  'at the chipper\'s salad rack the big button takes a tube salad; Eat salad eats it, and the big button gives it to a player you look at   ' +
  'on the rope tail: the slider hauls (up) and eases (down), {wraps}   {menu} settings (Respawn player is in there)';
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
  const covered = menu.open || stk.open;            // the settings menu or the sticker dialog has the mouse and keyboard
  if (covered) { input.mouse.l = input.mouse.r = false; }
  const inp = input.poll(dt);
  if (input.menuToggled) { input.menuToggled = false; menu.toggle(); }
  input.menuOpen = menu.open || stk.open;          // the menu's Close button shuts it too

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
  } else if (role === 'client') {
    // nothing at all from the host (not even an answer to a ping, which a hidden host tab still sends): gone
    if (performance.now() - lastHeard > CFG.HOST_TIMEOUT * 1000) handover.lost();
    interp.advance();
    inputTimer += dt;
    let sent = false;
    if (inputTimer >= 1 / CFG.INPUT_HZ) { inputTimer = 0; net.sendFast({ t: 'in', n: ++inSeq, i: inp }); sent = true; }
    // your own climber, drawn where the host will put it rather than where it last said (net/predict.js, D103)
    predict.frame(dt, inp, sent ? inSeq : inSeq + 1, mine, (id) => interp.pose(id), view.flexNow);
    const pm = stats.ping(performance.now()); if (pm) net.sendFast(pm, true);
    stats.routeCheck(performance.now(), () => Net.route(net.fast));
  }

  let src = sim ? hostSource : interp ? { pose: (id) => interp.pose(id), line: lineOf } : interp, auxV = aux;
  if (!sim && predict && predict.pos) {
    const P = predict.pos, pid = 60000 + me;
    src = { pose: (id) => (id === pid ? { p: { x: P[0], y: P[1], z: P[2] }, q: interp.pose(id)?.q || { x: 0, y: 0, z: 0, w: 1 } } : interp.pose(id)), line: lineOf };
    auxV = { ...aux, pl: aux.pl.map((a) => (a.id === me ? predict.patch(a) : a)) };
  }
  view.update(dt, src, auxV, me, inp);
  let info = role === 'solo' ? 'solo' : role === 'host' ? `HOST  room ${room}  (${[...net.clients.values()].filter((c) => c.ready).length} joined)` : `joined ${room}${CFG.NET_STATS ? `  ${stats.short()}` : ''}`;
  if (role === 'host') for (const c of net.clients.values()) if (c.st) info += `  P${c.pid} ${c.st.r} ms ${Math.round(Math.max(c.st.l, upLoss(c)) * 100)}%${c.st.via === 'relay' ? ' RELAY' : ''}`;
  hud.net(role === 'client' && CFG.NET_STATS ? stats.lines(performance.now()) : null);
  hud.update(dt, aux, me, info, input.device);
  input.touch.sync(mine, !menu.open && !stk.open);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  // rAF stops in a hidden tab, so the host's sim (and everyone's game) pauses. See DESIGN.md risk 3 / task P2-8.
  if (sim && net.clients.size && !document.hidden) hud.toast('Host tab was hidden: the game was paused for everyone');
});
if (room) localStorage.setItem('arb-room', room);

// handy for poking at things from the console
window.arb = { CFG, world, view, menu, net, stage, book, stk, get sim() { return sim; }, get aux() { return aux; }, get me() { return me; }, input };
