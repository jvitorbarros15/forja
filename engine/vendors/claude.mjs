import fs from 'node:fs';
import { IS_WIN } from '../platform.mjs';
import { renderAgent } from '../registry.mjs';
import { paths } from '../state.mjs';
import { exec } from './proc.mjs';

// On Windows the real binary is claude.exe. Order: an existing configured file, the native installer path, the npm
// package path, then proc.mjs resolves the bare name on PATH (.exe first, then the npm shim's target).
export function bin(cfg, env = process.env) {
  const b = cfg.vendors?.claude?.bin ?? 'claude';
  if (!IS_WIN || b !== 'claude') return b;
  const known = [`${env.USERPROFILE}/.local/bin/claude.exe`, `${env.APPDATA}/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`];
  return known.find((f) => fs.existsSync(f)) ?? b;
}

// Each agent gets an allow-list, not a deny-list: --restricted ignores every settings file and keeps the file tools inside
// cwd and --add-dir, and dontAsk refuses anything not listed.
export function runAgent(cfg, role, a, onPid) {
  const fm = renderAgent(cfg, role), allow = role.allow(a), dirs = [a.jobDir ?? paths(cfg).jobs(a.issue), ...(a.dirs ?? []), ...fm.skillDirs];
  const tools = [...new Set(allow.map((t) => t.split('(')[0]))].join(',');
  const argv = ['-p', '--model', a.model, '--output-format', 'json', '--restricted', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--tools', tools, '--allowedTools', ...allow, '--disallowedTools', ...role.deny, '--add-dir', ...dirs, '--append-system-prompt', fm.body];
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
  return exec(bin(cfg), argv, { cwd: a.cwd, env, input: a.prompt, timeoutMs: cfg.limits.agentTimeoutMin * 60e3, onPid }).then(({ code, out, err }) => ({ code, out, err }));
}
