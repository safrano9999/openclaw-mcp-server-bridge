import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BridgeError, ID } from './state.js';

export class HandlerRegistry {
  constructor(stateDir, directory = fileURLToPath(new URL('../extensions/', import.meta.url))) {
    this.stateRoot = path.join(stateDir, ID);
    this.handlers = new Map(); this.queues = new Map();
    if (!fs.existsSync(directory)) return;
    for (const folder of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!folder.isDirectory() || !/^[a-z][a-z0-9_-]{0,63}$/.test(folder.name)) continue;
      const name = folder.name;
      const root = path.join(directory, name);
      const script = path.join(root, `${name}.py`);
      const config = JSON.parse(fs.readFileSync(path.join(root, `${name}.json`), 'utf8'));
      if (!fs.statSync(script).isFile() || typeof config.description !== 'string') throw new BridgeError('invalid_handler');
      this.handlers.set(name, { script, root, config });
    }
  }
  list() { return [...this.handlers].map(([name, value]) => ({ name, description: value.config.description })); }
  async run(name, input, signal) {
    const handler = this.handlers.get(name);
    if (!handler) throw new BridgeError('unknown_handler');
    const state = path.join(this.stateRoot, name);
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      const timeout = Math.min(handler.config.timeoutSeconds ?? 420, 600) * 1000;
      const controller = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
      const child = spawn('python3', [handler.script], { cwd: handler.root, signal: controller,
        stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      let output = ''; let size = 0; let failed = false;
      const fail = code => { if (!failed) { failed = true; reject(new BridgeError(code)); } };
      child.on('error', () => fail(controller.aborted ? 'handler_timeout' : 'handler_start_failed'));
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 262144) { child.kill(); fail('handler_output_too_large'); } else output += chunk; });
      // Handler stderr is intentionally not returned: runtime errors may mention secret paths.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ ...input, state_dir: state, config: handler.config }));
      child.on('close', code => {
        if (failed) return;
        if (code !== 0) return fail('handler_failed');
        try {
          const value = JSON.parse(output);
          if (value.error) return fail(value.error);
          if (value.attachments) {
            if (!Array.isArray(value.attachments) || value.attachments.length > 4) return fail('invalid_handler_attachments');
            value.attachments = value.attachments.map(file => {
              const resolved = fs.realpathSync(file);
              if (!resolved.startsWith(fs.realpathSync(state) + path.sep) || fs.statSync(resolved).size > 8 * 1024 * 1024) throw Error();
              return resolved;
            });
          }
          resolve(value);
        } catch { fail('invalid_handler_response'); }
      });
    });
  }
  invoke(name, payload, signal, deliver) {
    if (!this.handlers.has(name)) throw new BridgeError('unknown_handler');
    const previous = this.queues.get(name) ?? Promise.resolve();
    const work = previous.then(async () => {
      signal.throwIfAborted();
      const prepared = await this.run(name, { action: 'prepare', payload }, signal);
      if (prepared.duplicate) return { ...prepared, status: 'duplicate' };
      let delivery;
      try { delivery = await deliver(prepared); }
      catch (error) { delivery = { status: 'failed', error: error instanceof BridgeError ? error.code : 'delivery_unknown' }; }
      await this.run(name, { action: 'receipt', receipt_id: prepared.receipt_id, delivery }, signal);
      return { ok: prepared.ok, status: delivery.status, refresh: prepared.refresh,
        delivered: delivery.status === 'sent', delivery, event_id: prepared.receipt_id };
    });
    const settled = work.catch(() => {});
    this.queues.set(name, settled);
    settled.finally(() => { if (this.queues.get(name) === settled) this.queues.delete(name); });
    return work;
  }
}
