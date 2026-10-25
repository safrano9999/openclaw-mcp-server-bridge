import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, ID } from './state.js';

// One current destination per agent; messages and credentials never enter this file.
export class RouteStore {
  constructor(stateDir) {
    this.file = path.join(stateDir, ID, 'routes.json');
    this.data = { version: 1, epoch: null, routes: {} };
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new BridgeError('route_state_unreadable'); }
    if (this.data?.version !== 1 || !this.data.routes || Array.isArray(this.data.routes) ||
        typeof this.data.routes !== 'object') throw new BridgeError('route_state_invalid');
  }
  sync(epoch, agentIds) {
    const routes = this.data.epoch === epoch
      ? Object.fromEntries(Object.entries(this.data.routes).filter(([id]) => agentIds.includes(id))) : {};
    if (this.data.epoch !== epoch || Object.keys(routes).length !== Object.keys(this.data.routes).length)
      this.write({ version: 1, epoch, routes });
  }
  get(id) { return Object.hasOwn(this.data.routes, id) ? this.data.routes[id] : undefined; }
  set(id, route) { this.write({ ...this.data, routes: { ...this.data.routes, [id]: route } }); }
  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx', flush: true });
      fs.renameSync(temporary, this.file);
      this.data = data;
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
