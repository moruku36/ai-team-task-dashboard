import { emptyBoard } from './model.mjs';
// Local entry only: ephemeral synthetic data, never a production fallback.
export class SyntheticStore {
  constructor() { this.state = emptyBoard(); this.queue = Promise.resolve(); }
  async read() { return structuredClone(this.state); }
  transaction(change) {
    const job = this.queue.then(() => { const next = structuredClone(this.state); const result = change(next); this.state = next; return result; });
    this.queue = job.catch(() => {}); return job;
  }
}
