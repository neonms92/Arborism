// PeerJS transport. Star topology: clients connect only to the host, with two
// data connections each: 'rel' (reliable, ordered, JSON strings) and 'fast'
// (unreliable, unordered: binary snapshots + JSON aux/input).
// See docs/DESIGN.md 2.1.   Peer is the global from vendor/peerjs.

import { CFG } from '../config.js';

function peerOptions() {
  const q = new URLSearchParams(location.search), o = { debug: 1 };
  const sig = q.get('signal');                       // ?signal=host:port  (own / local PeerServer)
  if (sig) {
    const [host, port] = sig.split(':');
    o.host = host; o.port = +(port || 443); o.path = '/';
    o.secure = !(host === 'localhost' || host === '127.0.0.1') && o.port === 443;
  }
  const ice = q.get('ice');                          // ?ice=<json array of RTCIceServer>
  if (ice) { try { o.config = { iceServers: JSON.parse(ice) }; } catch { console.warn('bad ?ice='); } }
  return o;
}

export class Net {
  constructor() {
    this.peer = null; this.isHost = false;
    this.clients = new Map();     // key (remote peer id) -> {rel, fast, pid, ready}
    this.rel = null; this.fast = null;   // client side
    // callbacks
    this.onJoin = () => {}; this.onLeave = () => {}; this.onClientData = () => {};
    this.onHostData = () => {}; this.onLost = () => {};
  }

  host(room) {
    this.isHost = true;
    return new Promise((resolve, reject) => {
      const peer = this.peer = new Peer(CFG.PEER_PREFIX + room, peerOptions());
      let opened = false;
      peer.on('open', () => { opened = true; resolve(); });
      // before the room is registered any error is fatal; afterwards only log (peers stay connected without signaling)
      peer.on('error', (e) => { if (!opened) { peer.destroy(); reject(e); } else console.warn('signaling:', e.type); });
      peer.on('disconnected', () => { if (opened) setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 5000); });
      peer.on('connection', (conn) => {
        const key = conn.peer;
        let c = this.clients.get(key); if (!c) this.clients.set(key, c = { rel: null, fast: null, pid: -1, ready: false });
        c[conn.label === 'rel' ? 'rel' : 'fast'] = conn;
        conn.on('open', () => { if (conn.label === 'rel') this.onJoin(key, c); });
        conn.on('data', (d) => this.onClientData(key, c, d));
        const gone = () => { if (this.clients.get(key) === c) { this.clients.delete(key); this.onLeave(key, c); } };
        conn.on('close', gone); conn.on('error', gone);
      });
    });
  }

  join(room) {
    this.isHost = false;
    return new Promise((resolve, reject) => {
      const peer = this.peer = new Peer(undefined, peerOptions());
      const fail = (e) => reject(e);
      const timer = setTimeout(() => reject(new Error('timed out - the host may be unreachable from your network')), 20000);
      peer.on('error', fail);
      peer.on('open', () => {
        const id = CFG.PEER_PREFIX + room;
        this.rel = peer.connect(id, { label: 'rel', reliable: true, serialization: 'raw' });
        this.fast = peer.connect(id, { label: 'fast', reliable: false, serialization: 'raw' });
        this.rel.on('open', () => { clearTimeout(timer); resolve(); });
        this.rel.on('data', (d) => this.onHostData(d));
        this.fast.on('data', (d) => this.onHostData(d));
        this.rel.on('close', () => this.onLost());
        this.rel.on('error', fail);
      });
    });
  }

  /** Bytes waiting to go out on a connection: the browser's send buffer plus PeerJS's own (DESIGN 2.6). */
  static queued(conn) { return (conn?.dataChannel?.bufferedAmount || 0) + (conn?.bufferSize ? 1e9 : 0); }

  /** Which way the packets go: 'host' candidates both ends = straight across the LAN, 'relay' = through a TURN server. */
  static async route(conn) {
    const pc = conn?.peerConnection; if (!pc) return null;
    const rep = await pc.getStats(); let pair = null;
    rep.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = rep.get(r.selectedCandidatePairId); });
    if (!pair) rep.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return null;
    const l = rep.get(pair.localCandidateId), r = rep.get(pair.remoteCandidateId);
    return { local: l?.candidateType, remote: r?.candidateType, rtt: pair.currentRoundTripTime };
  }

  // host -> clients
  sendRel(c, obj) { if (c.rel?.open) c.rel.send(JSON.stringify(obj)); }
  broadcastRel(obj) { const s = JSON.stringify(obj); for (const c of this.clients.values()) if (c.ready && c.rel?.open) c.rel.send(s); }
  broadcastFast(data) {
    const d = typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data);
    for (const c of this.clients.values()) {
      if (!c.ready || !c.fast?.open) continue;
      // Snapshots and aux are latest-wins: if the link has not taken the last ones yet, a new one would only
      // queue behind them and arrive late. Skip it instead, so state is never more than this much old (D89).
      if (Net.backed(c, c.fast)) { c.skipped = (c.skipped || 0) + 1; continue; }
      c.fast.send(d); c.lastSent = (c.lastSent || 0) + (d.length || d.byteLength || 0);
    }
  }
  // client -> host
  sendFast(obj, always) {
    if (!this.fast?.open) return;
    const st = this.up || (this.up = {});
    if (!always && Net.backed(st, this.fast)) { this.skipped = (this.skipped || 0) + 1; return; }
    const d = JSON.stringify(obj); this.fast.send(d); st.lastSent = (st.lastSent || 0) + d.length;
  }

  /**
   * Is the link behind? True when more than NET_QUEUE_MAX kB waits, or when what waits would take longer
   * than NET_LAG_MAX to go out at the rate the link has been draining. st keeps the drain rate (D89).
   */
  static backed(st, conn) {
    const now = performance.now(), q = Net.queued(conn);
    if (st.t !== undefined && st.q > 0 && q < 1e9) {           // the queue had data: what left it is the link's pace
      const dt = (now - st.t) / 1000, out = st.q + (st.lastSent || 0) - q;
      if (dt > 0 && out >= 0) st.rate = st.rate ? st.rate + (out / dt - st.rate) * 0.2 : out / dt;
    }
    st.t = now; st.q = q; st.lastSent = 0;
    if (q > CFG.NET_QUEUE_MAX * 1024) return true;
    return q > 2048 && st.rate > 0 && q / st.rate > CFG.NET_LAG_MAX;
  }
}
