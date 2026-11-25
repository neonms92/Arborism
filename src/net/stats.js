// Network statistics, measured on a joined client (DESIGN.md 2.6).
//   ping      the client sends {t:'pi'} on the fast channel every CFG.PING_EVERY s, the host answers {t:'po'}
//             at once; round trip from the client's own clock. A ping with no answer in 2 s counts as lost.
//   loss down snapshots go out every CFG.SNAP_EVERY ticks, so tick numbers show which ones never arrived.
//   loss up   inputs carry a sequence number; the host counts the gaps and sends the figure back in 'po'.
//   host sim  host ticks per wall second over the window (below 100%: the host machine cannot keep up).
//   host fps  the host's frame rate, sent back in 'po': pings are answered between frames, so it adds to ping.
//   late      how much later than the quickest one each snapshot arrives (max over the window): data queuing
//             somewhere on the way. Seconds here is the 1-2 s lag; ping (also on the fast channel) shows it too.
//   queue     bytes waiting in the host's send buffer for this client, and how many updates it skipped
//             because of them (net.js broadcastFast, CFG.NET_QUEUE_MAX).
//   route     the WebRTC candidate pair in use: host-host is straight across the LAN; relay means every
//             packet goes out to a TURN server on the internet and back (PeerJS's free ones by default).
//   delay     what your own moves take to come back on screen: input wait + round trip + host frame +
//             the client's render delay (CFG.INTERP_DELAY). An estimate, not a measurement.
// Only the main thread uses this; the host keeps its per-client figures on the connection object.

import { CFG } from '../config.js';

const WIN = 5000;          // ms window for loss, bandwidth and host speed
const PING_LOST = 2000;    // ms without a pong = lost

export class NetStats {
  constructor() {
    this.seq = 0; this.pingT = 0; this.sent = new Map();   // ping seq -> sent at
    this.rtts = []; this.pingOk = [];                       // last 20 round trips (ms) / outcomes
    this.snaps = []; this.bytes = []; this.late = 0;        // {tick, at} / {at, n}
    this.up = null; this.hostFps = 0;                       // uplink loss and frame rate the host reports
    this.q = 0; this.sk = 0;                                // host send queue (bytes), updates it skipped
    this.lates = []; this.via = null; this.routeT = -1e9;   // {at, ms} / candidate pair
  }

  /** Called every frame on a client; returns a ping message when one is due. */
  ping(now) {
    for (const [s, at] of this.sent) if (now - at > PING_LOST) { this.sent.delete(s); this.out(false); }
    if (now - this.pingT < CFG.PING_EVERY * 1000) return null;
    this.pingT = now; const s = ++this.seq; this.sent.set(s, now);
    return { t: 'pi', s, r: Math.round(this.rtt()), l: this.lossDown(), via: this.via?.local === 'relay' || this.via?.remote === 'relay' ? 'relay' : this.via ? 'direct' : '' };
  }

  pong(m, now) {
    const at = this.sent.get(m.s); if (at === undefined) return;
    this.sent.delete(m.s); this.out(true);
    this.rtts.push(now - at); if (this.rtts.length > 20) this.rtts.shift();
    if (Number.isFinite(m.up)) this.up = m.up;
    if (Number.isFinite(m.fps)) this.hostFps = m.fps;
    if (Number.isFinite(m.q)) this.q = m.q;
    if (Number.isFinite(m.sk)) this.sk = m.sk;
  }

  out(ok) { this.pingOk.push(ok); if (this.pingOk.length > 20) this.pingOk.shift(); }

  /** Every packet from the host (bytes for bandwidth). */
  packet(n, now) { this.bytes.push({ at: now, n }); this.trim(this.bytes, now); }

  /** Every snapshot's tick, including ones that come too late to be drawn. */
  snap(tick, now, stale, transit) {
    if (stale) this.late++;
    // host speed is judged on the host's own send clock when there is one, so a queue on the way does not read as a slow host
    this.snaps.push({ tick, at: Number.isFinite(transit) ? now - transit : now }); this.trim(this.snaps, now);
    // transit = local arrival - host send clock: unknown (fixed) clock offset + real transit. Against the
    // quickest packet since joining, it is how late a packet is.
    if (Number.isFinite(transit)) {
      this.lates.push({ at: now, ms: transit }); this.trim(this.lates, now);
      this.bestTransit = Math.min(this.bestTransit ?? Infinity, transit);
    }
  }

  /** Worst arrival lateness in the window, against the quickest packet since joining (ms). */
  lateMax() { let hi = -Infinity; for (const l of this.lates) hi = Math.max(hi, l.ms); return hi > this.bestTransit ? hi - this.bestTransit : 0; }

  /** Every 2 s, ask the browser which way the packets go. */
  routeCheck(now, get) {
    if (now - this.routeT < 2000) return;
    this.routeT = now;
    get().then((r) => { if (r) this.via = r; }).catch(() => {});
  }

  routeText() {
    const v = this.via; if (!v) return 'route: unknown';
    const relay = v.local === 'relay' || v.remote === 'relay';
    const net = Number.isFinite(v.rtt) ? `, network round trip ${Math.round(v.rtt * 1000)} ms` : '';
    if (relay) return `route: THROUGH A RELAY SERVER on the internet${net}`;
    if (v.local === 'host' && v.remote === 'host') return `route: direct on the local network${net}`;
    return `route: direct over the internet (${v.local}/${v.remote})${net}`;
  }

  trim(a, now) { while (a.length && now - a[0].at > WIN) a.shift(); }   // snaps hold send times, close enough for a 5 s window

  rtt() { return this.rtts.length ? this.rtts[this.rtts.length - 1] : 0; }
  rttAvg() { return this.rtts.length ? this.rtts.reduce((a, b) => a + b, 0) / this.rtts.length : 0; }
  /** Mean absolute change between successive round trips (ms). */
  jitter() { let s = 0; for (let i = 1; i < this.rtts.length; i++) s += Math.abs(this.rtts[i] - this.rtts[i - 1]); return this.rtts.length > 1 ? s / (this.rtts.length - 1) : 0; }

  /** Fraction of snapshots that never arrived in the window. */
  lossDown() {
    const a = this.snaps; if (a.length < 2) return 0;
    let lo = Infinity, hi = -Infinity; const got = new Set();
    for (const s of a) { lo = Math.min(lo, s.tick); hi = Math.max(hi, s.tick); got.add(s.tick); }
    const want = Math.floor((hi - lo) / CFG.SNAP_EVERY) + 1;
    return want > 0 ? Math.max(0, 1 - got.size / want) : 0;
  }
  lossPing() { return this.pingOk.length ? this.pingOk.filter((o) => !o).length / this.pingOk.length : 0; }

  /** Host simulation speed relative to real time (1 = keeping up). */
  hostSpeed() {
    const a = this.snaps; if (a.length < 2) return 1;
    let lo = a[0], hi = a[0];
    for (const s of a) { if (s.tick < lo.tick) lo = s; if (s.tick > hi.tick) hi = s; }
    const wall = (hi.at - lo.at) / 1000;
    return wall > 1 ? (hi.tick - lo.tick) * CFG.TICK / wall : 1;
  }

  kBps(now) { let n = 0; for (const b of this.bytes) n += b.n; return n / 1024 / (Math.min(WIN, Math.max(1000, now - (this.bytes[0]?.at ?? now))) / 1000); }

  /** Estimated time from pressing a key to seeing yourself move (ms). */
  delay() { return this.rttAvg() + 500 / CFG.INPUT_HZ + 8 + CFG.INTERP_DELAY * 1000; }

  /** Lines for the HUD's network box. */
  lines(now) {
    const pc = (x) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
    const out = [
      `ping ${Math.round(this.rtt())} ms  (avg ${Math.round(this.rttAvg())}, jitter ${Math.round(this.jitter())})`,
      `loss  down ${pc(this.lossDown())}  up ${this.up == null ? '-' : pc(this.up)}  ping ${pc(this.lossPing())}`,
      `your moves show after ~${Math.round(this.delay())} ms  (render delay ${Math.round(CFG.INTERP_DELAY * 1000)})`,
      `in ${this.kBps(now).toFixed(1)} kB/s   snapshots up to ${Math.round(this.lateMax())} ms late`,
      this.routeText(),
    ];
    if (this.q > 2048 || this.sk) out.push(`host send queue ${(this.q / 1024).toFixed(0)} kB, ${this.sk} stale updates skipped`);
    const hs = this.hostSpeed();
    if (hs < 0.95) out.push(`host is running slow: ${Math.round(hs * 100)}% speed`);
    // the host answers pings between its frames, so a slow host frame shows up in ping too
    if (this.hostFps && this.hostFps < 40) out.push(`host draws ${this.hostFps} fps (adds up to ${Math.round(1000 / this.hostFps)} ms)`);
    if (this.late) out.push(`${this.late} snapshots came out of order`);
    return out;
  }

  /** One-glance figure for the status line. */
  short() { return `ping ${Math.round(this.rtt())} ms  loss ${Math.round(Math.max(this.lossDown(), this.up || 0) * 100)}%`; }
}

/** Host side: count gaps in a client's input sequence numbers over the last 5 s. */
export function upCount(c, n, now) {
  const u = c.up || (c.up = { hi: -1, got: [] });
  if (n <= u.hi) return false;                         // older than one already used: drop it
  u.hi = n; u.got.push({ n, at: now });
  while (u.got.length && now - u.got[0].at > WIN) u.got.shift();
  return true;
}
export function upLoss(c) {
  const g = c.up?.got; if (!g || g.length < 2) return 0;
  return Math.max(0, 1 - g.length / (g[g.length - 1].n - g[0].n + 1));
}
