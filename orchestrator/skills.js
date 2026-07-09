// Command-deck skills + persisted panel data (objectives, reminders).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class Skills {
  constructor(stateDir) {
    this.stateDir = stateDir;
    mkdirSync(this.stateDir, { recursive: true });
  }

  loadList(name) {
    try {
      return JSON.parse(readFileSync(path.join(this.stateDir, `${name}.json`), 'utf8'));
    } catch {
      return [];
    }
  }

  saveList(name, items) {
    writeFileSync(path.join(this.stateDir, `${name}.json`), JSON.stringify(items, null, 2));
  }

  openApp(target) {
    return new Promise((resolve, reject) => {
      const child = spawn('open', ['-a', target]);
      child.on('close', (code) => code === 0 ? resolve(`Opened ${target}`) : reject(new Error(`Could not open "${target}"`)));
      child.on('error', reject);
    });
  }

  systemStatus() {
    const total = os.totalmem();
    const free = os.freemem();
    const load = os.loadavg()[0];
    const up = os.uptime();
    return {
      cpuLoad: Math.min(100, Math.round((load / os.cpus().length) * 100)),
      memUsedPct: Math.round(((total - free) / total) * 100),
      memUsedGb: ((total - free) / 1e9).toFixed(1),
      memTotalGb: (total / 1e9).toFixed(0),
      uptimeHours: (up / 3600).toFixed(1),
      hostname: os.hostname().replace(/\.local$/, ''),
    };
  }
}
