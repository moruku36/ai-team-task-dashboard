import { emptyBoard } from './model.mjs';
// Local entry only: ephemeral synthetic data, never a production fallback.
// Synthetic-only quota records (no collector, no network, no persistence). Not a production fallback.
export class SyntheticQuotaStore {
  constructor(records = []) { this.records = structuredClone(records); }
  async read() { return { records: structuredClone(this.records) }; }
}
export class SyntheticStore {
  constructor() { this.state = emptyBoard(); this.queue = Promise.resolve(); }
  async read() { return structuredClone(this.state); }
  transaction(change) {
    const job = this.queue.then(() => { const next = structuredClone(this.state); const result = change(next); this.state = next; return result; });
    this.queue = job.catch(() => {}); return job;
  }
}
