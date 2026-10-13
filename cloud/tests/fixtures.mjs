import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { emptyBoard } from '../model.mjs';
import { handler } from '../server.mjs';
import { syntheticOwnerAuthorize } from './synthetic-auth.mjs';
export const env = { DASHBOARD_ORIGIN: 'http://synthetic.invalid' };
export const task = { id: 'SYNTH-1', title: '合成タスク', status: 'To Do', owner: 'synthetic-agent', group: '現行', detail: '<script>alert(1)</script>', lastConfirmedAt: null };
export const command = (version, status, requestId) => ({ expectedVersion: version, requestId, task: { ...task, status } });
export class FixtureStore {
  constructor(file) { this.file = file; this.state = emptyBoard(); this.queue = Promise.resolve(); }
  async read() { return this.file ? JSON.parse(await readFile(this.file, 'utf8')) : structuredClone(this.state); }
  transaction(change) {
    const job = this.queue.then(async () => {
      const next = await this.read(), result = change(next);
      if (this.failWrite) throw new Error('synthetic-write-failure SECRET_SENTINEL');
      if (this.file) await writeFile(this.file, JSON.stringify(next)); else this.state = next;
      return result;
    }); this.queue = job.catch(() => {}); return job;
  }
}
export async function app(store = new FixtureStore(), options = {}) {
  const server = createServer(handler({ store, env, authorize: syntheticOwnerAuthorize, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { store, server, url, close: () => new Promise(resolve => server.close(resolve)),
    get: path => fetch(url + path),
    post: (body, headers = {}) => fetch(url + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Write': '1', Origin: env.DASHBOARD_ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) };
}
