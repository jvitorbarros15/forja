import fs from 'node:fs';
import path from 'node:path';

const HOUR = 3600e3;
const COOLDOWN = HOUR;

const file = (stateDir) => path.join(stateDir, 'quota.json');

function readQuota(stateDir) {
  try { return JSON.parse(fs.readFileSync(file(stateDir), 'utf8')); } catch { return { calls: [] }; }
}

function writeQuota(stateDir, data) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${file(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(stateDir));
}

export function parseEntry(entry) {
  const i = entry.indexOf(':');
  return { vendor: entry.slice(0, i), model: entry.slice(i + 1) };
}

export function quota(stateDir, now = Date.now()) {
  const calls = readQuota(stateDir).calls;
  const out = {};
  for (const p of new Set(['claude', ...calls.map((c) => c.p)])) {
    const mine = calls.filter((c) => c.p === p);
    const last = mine.at(-1);
    const until = last?.limited ? (last.until ? Date.parse(last.until) : Date.parse(last.at) + COOLDOWN) : 0;
    out[p] = {
      h5: mine.filter((c) => now - Date.parse(c.at) < 5 * HOUR).length,
      week: mine.filter((c) => now - Date.parse(c.at) < 168 * HOUR).length,
      limitedUntil: until > now ? new Date(until).toISOString() : null,
    };
  }
  return out;
}

export function logCall(stateDir, vendor, issue, kind, limited = false, until = null) {
  const q = readQuota(stateDir);
  const cut = Date.now() - 192 * HOUR;
  q.calls = [
    ...q.calls.filter((c) => Date.parse(c.at) > cut),
    { p: vendor, at: new Date().toISOString(), issue, kind, limited, ...(until ? { until } : {}) },
  ];
  writeQuota(stateDir, q);
}

export function pick(chain, { avoidVendor, avoidModel, q = {}, multiVendor: multi = false, strict = false } = {}) {
  const free = (vendor) => vendor === 'local' || !q[vendor]?.limitedUntil;
  const open = chain.filter((e) => free(parseEntry(e).vendor));
  const other = multi ? open.find((e) => parseEntry(e).vendor !== avoidVendor) : undefined;
  if (other) return other;
  const diff = open.find((e) => parseEntry(e).model !== avoidModel);
  if (diff) return diff;
  if (strict) return null;
  if (avoidVendor && avoidModel && free(avoidVendor)) return `${avoidVendor}:${avoidModel}`;
  return free('claude') ? 'claude:sonnet' : null;
}

export const multiVendor = (cfg) =>
  Object.entries(cfg.vendors ?? {}).some(([v, c]) => v !== 'claude' && v !== 'local' && c?.enabled);

export function nextRung(cfg, rung) {
  const esc = cfg.models.buildEscalation;
  const i = esc.indexOf(rung);
  return i < 0 ? null : esc[i + 1] ?? null;
}
