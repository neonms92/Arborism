// One test worker: its own module instance (so its own CFG) and its own Rapier
// world per run. Receives {id, job}, answers {id, rec} or {id, error}.

import { runCase } from './runcase.js';

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try { self.postMessage({ id, rec: await runCase(job) }); }
  catch (err) { self.postMessage({ id, error: String((err && err.stack) || err) }); }
};
self.postMessage({ ready: true });
