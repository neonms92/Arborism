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
      peer.on('open', () => resolve());
      peer.on('error', (e) => { reject(e); console.warn('peer error', e.type); });
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
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

  // host -> clients
  sendRel(c, obj) { if (c.rel?.open) c.rel.send(JSON.stringify(obj)); }
  broadcastRel(obj) { const s = JSON.stringify(obj); for (const c of this.clients.values()) if (c.ready && c.rel?.open) c.rel.send(s); }
  broadcastFast(data) {
    const d = typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data);
    for (const c of this.clients.values()) if (c.ready && c.fast?.open) c.fast.send(d);
  }
  // client -> host
  sendFast(obj) { if (this.fast?.open) this.fast.send(JSON.stringify(obj)); }
}
