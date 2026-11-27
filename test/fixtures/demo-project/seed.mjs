// Writes a dashboard demo state: one job per stage, a queue, commands, deploy runs and a runner heartbeat with a vendor limit.
//   node seed.mjs [stateDir] [pid]   times are relative to now; pid is the process the heartbeat claims to be (default: this one)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const put = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };

export function seed(state = `${HERE}/.forja/state`, { now = Date.now(), pid = process.pid } = {}) {
  const at = min => new Date(now - min * 60e3).toISOString();
  const ev = list => list.map(([min, text]) => ({ at: at(min), text }));
  const tk = (input, output) => ({ input, output, total: input + output });
  const worker = (id, model, vendor, role, round, status, start, mins, tokens) => ({
    id, model, vendor, role, round, status, startedAt: at(start), endedAt: status === 'running' ? null : at(start - mins),
    durationMs: status === 'running' ? null : mins * 60e3, tokens, estimated: false,
  });
  const byVendor = ws => {
    const t = { input: 0, output: 0, total: 0, estimated: false, byVendor: {} };
    for (const w of ws) if (w.tokens) {
      const v = (t.byVendor[w.vendor] ??= { input: 0, output: 0, total: 0, estimated: false });
      for (const x of [t, v]) { x.input += w.tokens.input; x.output += w.tokens.output; x.total += w.tokens.total; }
    }
    return t;
  };
  const job = (j) => ({
    pr: null, summary: '', tier: null, round: 0, branch: null, reviews: {}, files: [], events: [], note: '', need: null, running: [], paused: false, approved: false,
    since: null, ci: null, retryAt: null, workers: [], triage: null, ai: null, ...j, tokens: byVendor(j.workers ?? []),
  });

  const docs = [
    job({
      issue: 101, title: 'Add CSV export to the reports page', stage: 'spec', summary: 'Let people download any report as CSV from the toolbar.',
      updatedAt: at(1), since: at(3), running: ['spec'], triage: { tier: 'A', bucket: 'factory', reason: 'Only touches a new export button and a pure formatting helper.', model: 'qwen3', ms: 910 },
      events: ev([[3, 'Issue received'], [3, 'Writing the spec']]),
      workers: [worker('spec-0-sonnet', 'sonnet', 'claude', 'spec', 0, 'running', 3, 0, null)],
    }),
    job({
      issue: 102, title: 'Cache exchange rates for ten minutes', stage: 'build', tier: 'B', round: 2, branch: 'forja/102-cache-rates', updatedAt: at(7), since: at(26),
      summary: 'Stop calling the rates API on every price render.',
      events: ev([[58, 'Issue received'], [52, 'Spec ready: tier B, executor medium.'], [41, 'Building (medium)'], [33, 'Review asked for changes (code); round 2'], [26, 'External executor quota exhausted; the build continues with Sonnet'], [7, 'Building (codex)']]),
      workers: [
        worker('spec-0-sonnet', 'sonnet', 'claude', 'spec', 0, 'ok', 58, 5, tk(9100, 2300)),
        worker('builder-1-sonnet', 'sonnet', 'claude', 'builder', 1, 'ok', 41, 8, tk(41200, 9800)),
        worker('review-code-1', 'sonnet', 'claude', 'review-code', 1, 'ok', 32, 3, tk(18400, 1600)),
        worker('review-ponytail-1', 'sonnet', 'claude', 'review-ponytail', 1, 'ok', 32, 2, tk(15900, 1100)),
        worker('build-2-codex', 'codex:gpt-5.1-codex', 'codex', 'build', 2, 'failed', 9, 2, null),
      ],
    }),
    job({
      issue: 103, title: 'Show payment retries on the invoice screen', stage: 'review', tier: 'B', round: 2, branch: 'forja/103-payment-retries', updatedAt: at(2), since: at(4),
      summary: 'List each failed attempt with its reason so support can answer without opening the logs.',
      reviews: { code: { verdict: 'PASS', note: 'Retry list is derived from existing state; no duplicated fetch.' }, ui: { verdict: 'pending' }, ponytail: { verdict: 'pending', note: 'Held until the first reviews pass.' } },
      files: [{ path: 'src/invoices/Retries.tsx', add: 64, del: 3 }, { path: 'src/invoices/InvoiceScreen.tsx', add: 9, del: 1 }, { path: 'test/retries.test.ts', add: 41, del: 0 }],
      events: ev([[44, 'Issue received'], [30, 'Spec ready: tier B, executor medium.'], [22, 'Review asked for changes (ui); round 2'], [9, 'Checks passed; review (code, ui)'], [4, 'Checks passed; review (code, ui)']]),
      workers: [
        worker('spec-0-sonnet', 'sonnet', 'claude', 'spec', 0, 'ok', 44, 6, tk(8800, 2100)),
        worker('builder-1-sonnet', 'sonnet', 'claude', 'builder', 1, 'ok', 29, 7, tk(38800, 8200)),
        worker('review-code-1', 'sonnet', 'claude', 'review-code', 1, 'ok', 22, 3, tk(17100, 1500)),
        worker('review-ui-1', 'sonnet', 'claude', 'review-ui', 1, 'ok', 22, 4, tk(21900, 1800)),
        worker('builder-2-sonnet', 'sonnet', 'claude', 'builder', 2, 'ok', 15, 5, tk(30100, 6200)),
        worker('review-code-2', 'sonnet', 'claude', 'review-code', 2, 'ok', 4, 2, tk(17600, 1300)),
        worker('review-ui-2', 'sonnet', 'claude', 'review-ui', 2, 'running', 4, 0, null),
      ],
    }),
    job({
      issue: 104, title: 'Rotate the signing key for webhook payloads', stage: 'approve', tier: 'C', round: 1, branch: 'forja/104-rotate-signing-key', updatedAt: at(1), since: at(2), running: ['approver'],
      summary: 'Support two active keys during rotation so receivers can switch without downtime.',
      reviews: { code: { verdict: 'PASS', note: 'Both keys verified in order; old key expires on schedule.' }, ponytail: { verdict: 'PASS', note: 'No new abstractions.' }, security: { verdict: 'PASS', note: 'Key material never logged; constant-time comparison kept.' } },
      files: [{ path: 'src/webhooks/sign.ts', add: 48, del: 12 }, { path: 'src/webhooks/keys.ts', add: 33, del: 0 }, { path: 'test/sign.test.ts', add: 70, del: 4 }],
      events: ev([[71, 'Issue received'], [60, 'Tier C: the strong model reviews the spec'], [38, 'Spec ready: tier C, executor hard.'], [11, 'Checks passed; review (code, ponytail, security)'], [2, 'Reviews passed; final approval']]),
      workers: [
        worker('spec-0-opus', 'opus', 'claude', 'spec', 0, 'ok', 71, 12, tk(14200, 4100)),
        worker('builder-1-opus', 'opus', 'claude', 'builder', 1, 'ok', 36, 24, tk(88100, 21400)),
        worker('review-code-1', 'sonnet', 'claude', 'review-code', 1, 'ok', 10, 4, tk(24400, 2100)),
        worker('review-ponytail-1', 'sonnet', 'claude', 'review-ponytail', 1, 'ok', 10, 3, tk(20100, 1400)),
        worker('review-security-1', 'opus', 'claude', 'review-security', 1, 'ok', 10, 6, tk(31800, 3900)),
        worker('approver-1', 'opus', 'claude', 'approver', 1, 'running', 2, 0, null),
      ],
    }),
    job({
      issue: 105, title: 'Fix off-by-one in the pagination footer', stage: 'pr', tier: 'A', round: 1, pr: 58, ci: 'pending', branch: 'forja/105-pagination-footer', updatedAt: at(6), since: at(6),
      summary: 'The last page showed one result too many.',
      reviews: { code: { verdict: 'PASS', note: 'Boundary fixed and covered by a test.' } },
      files: [{ path: 'src/ui/Pagination.tsx', add: 2, del: 2 }, { path: 'test/pagination.test.ts', add: 14, del: 0 }],
      events: ev([[28, 'Issue received'], [21, 'Spec ready: tier A, executor exact.'], [14, 'Checks passed; review (code)'], [6, 'PR opened, #58']]),
      workers: [worker('spec-0-sonnet', 'sonnet', 'claude', 'spec', 0, 'ok', 28, 4, tk(7600, 1800)), worker('review-code-1', 'sonnet', 'claude', 'review-code', 1, 'ok', 14, 2, tk(9300, 800))],
    }),
    job({
      issue: 106, title: 'Retry failed webhook deliveries with backoff', stage: 'needs-you', tier: 'C', round: 3, pr: 61, ci: 'pass', branch: 'forja/106-webhook-backoff', updatedAt: at(14), since: at(14),
      summary: 'Re-deliver failed webhooks with exponential backoff and a dead-letter list.',
      note: 'The reviews still ask for changes after 3 rounds (security).',
      need: {
        why: 'The reviews still ask for changes after 3 rounds (security). Reviewer note: the retry job runs without a per-endpoint concurrency cap, so one slow receiver can starve the rest.',
        action: 'Forja stops after 3 rounds so it does not spend without end; only you decide whether the reviewer request holds. Read the reviews below: if it does not hold, approve; otherwise redo with a note.',
        buttons: ['approve', 'redo'],
      },
      ai: { rec: 'redo', why: 'The concurrency gap is real: a stuck endpoint blocks the shared worker pool.', done: 'Read the diff and the security note; confirmed there is no cap in retry.ts.', note: 'Cap concurrent retries per endpoint at 2 and add a test with one slow receiver.' },
      reviews: { code: { verdict: 'PASS', note: 'Backoff math is correct and tested.' }, ponytail: { verdict: 'PASS', note: 'Small and direct.' }, security: { verdict: 'CHANGES', note: 'No per-endpoint concurrency cap; one slow receiver starves the rest.' } },
      files: [{ path: 'src/webhooks/retry.ts', add: 96, del: 11 }, { path: 'src/webhooks/deadletter.ts', add: 38, del: 0 }, { path: 'test/retry.test.ts', add: 112, del: 6 }],
      events: ev([[190, 'Issue received'], [172, 'Tier C: the strong model reviews the spec'], [150, 'Spec ready: tier C, executor hard.'], [96, 'Review asked for changes (security); round 2'], [40, 'Review asked for changes (security); round 3'], [14, 'The reviews still ask for changes after 3 rounds (security).']]),
      workers: [
        worker('spec-0-opus', 'opus', 'claude', 'spec', 0, 'ok', 190, 18, tk(15100, 4600)),
        worker('builder-1-opus', 'opus', 'claude', 'builder', 1, 'ok', 150, 26, tk(91200, 23800)),
        worker('review-code-1', 'sonnet', 'claude', 'review-code', 1, 'ok', 118, 4, tk(25100, 2200)),
        worker('review-ponytail-1', 'sonnet', 'claude', 'review-ponytail', 1, 'ok', 118, 3, tk(20300, 1500)),
        worker('review-security-1', 'opus', 'claude', 'review-security', 1, 'ok', 118, 7, tk(32200, 4100)),
        worker('builder-2-opus', 'opus', 'claude', 'builder', 2, 'ok', 94, 21, tk(77100, 18200)),
        worker('review-security-2', 'opus', 'claude', 'review-security', 2, 'ok', 66, 6, tk(33800, 3700)),
        worker('builder-3-opus', 'opus', 'claude', 'builder', 3, 'ok', 39, 19, tk(70400, 16900)),
        worker('review-code-3', 'sonnet', 'claude', 'review-code', 3, 'ok', 18, 3, tk(26200, 2000)),
        worker('review-ponytail-3', 'sonnet', 'claude', 'review-ponytail', 3, 'ok', 18, 2, tk(20800, 1300)),
        worker('review-security-3', 'opus', 'claude', 'review-security', 3, 'ok', 18, 6, tk(34400, 3600)),
        worker('advisor-3', 'sonnet', 'claude', 'advisor', 3, 'ok', 13, 1, tk(12100, 700)),
      ],
    }),
    job({
      issue: 107, title: 'Migrate the settings page to the new form components', stage: 'failed', tier: 'B', round: 3, pr: 63, ci: 'fail', branch: 'forja/107-settings-forms', updatedAt: at(33), since: at(33),
      note: 'CI on PR #63 failed after 3 rounds.',
      need: { why: 'CI on PR #63 failed after 3 rounds.', action: 'Forja already tried to fix it on its own and stops after 3 rounds. See the CI on the PR; Redo with a note asks for the fix.', buttons: ['redo'], blocked: 'CI is red, so there is nothing reviewed to merge.' },
      reviews: { code: { verdict: 'PASS' }, ui: { verdict: 'PASS' }, ponytail: { verdict: 'PASS' } },
      files: [{ path: 'src/settings/SettingsForm.tsx', add: 120, del: 98 }],
      events: ev([[140, 'Issue received'], [100, 'Spec ready: tier B, executor medium.'], [70, 'CI on PR #63 failed; round 2'], [50, 'CI on PR #63 failed; round 3'], [33, 'CI on PR #63 failed after 3 rounds.']]),
      workers: [worker('builder-3-sonnet', 'sonnet', 'claude', 'builder', 3, 'ok', 50, 12, tk(44100, 9100))],
    }),
    job({
      issue: 108, title: 'Show the order total with taxes on the checkout summary', stage: 'merged', tier: 'A', round: 1, pr: 52, branch: 'forja/108-checkout-taxes', updatedAt: at(95), since: at(95),
      reviews: { code: { verdict: 'PASS' } }, events: ev([[210, 'Issue received'], [140, 'Checks passed; review (code)'], [96, 'PR opened, #52'], [95, 'Merged']]),
      workers: [worker('spec-0-sonnet', 'sonnet', 'claude', 'spec', 0, 'ok', 210, 4, tk(6900, 1500)), worker('builder-1-haiku', 'haiku', 'claude', 'builder', 1, 'ok', 180, 7, tk(22100, 4800))],
    }),
    job({
      issue: 109, title: 'Document the environment variables', stage: 'deployed', tier: 'A', round: 1, pr: 49, branch: 'forja/109-env-docs', updatedAt: at(260), since: at(260),
      reviews: { code: { verdict: 'PASS' } }, events: ev([[420, 'Issue received'], [300, 'PR opened, #49'], [262, 'Merged'], [260, 'Deployed']]),
      workers: [worker('spec-0-sonnet', 'sonnet', 'claude', 'spec', 0, 'ok', 420, 3, tk(5100, 1200))],
    }),
    job({
      issue: 110, title: 'Add dark mode to the marketing banner', stage: 'build', tier: 'A', round: 1, paused: true, branch: 'forja/110-dark-banner', updatedAt: at(48), since: at(60),
      events: ev([[80, 'Issue received'], [60, 'Building (exact)'], [48, 'Pause requested by you']]),
      workers: [worker('spec-0-sonnet', 'sonnet', 'claude', 'spec', 0, 'ok', 80, 3, tk(5400, 1300))],
    }),
  ];

  rmSync(state, { recursive: true, force: true });
  for (const d of docs) put(`${state}/docs/${d.issue}.json`, d);
  put(`${state}/board.json`, { jobs: docs.map(d => ({ issue: d.issue, stage: d.stage, title: d.title })) });
  put(`${state}/queue.json`, [201, 202, 205]);
  put(`${state}/commands.json`, [
    { id: 'local-1', jobId: '106', action: 'redo', note: 'Cap retries per endpoint', status: 'done', at: at(150), doneAt: at(149) },
    { id: 'local-2', jobId: '108', action: 'deploy-test', note: '', status: 'done', at: at(90), doneAt: at(88) },
    { id: 'local-3', jobId: '103', action: 'pause', note: '', status: 'pending', at: at(0.2) },
  ]);
  put(`${state}/run-deploy-test.json`, { status: 'ok', startedAt: at(88), endedAt: at(79), note: 'Build and preview checks passed; nothing was published.', of: 108, ids: ['108'], tries: 1, pid });
  put(`${state}/run-deploy.json`, { status: 'ok', startedAt: at(270), endedAt: at(262), note: 'deployed 109', issues: [109], ids: ['109'], pid });
  put(`${state}/quota.json`, { calls: [] });
  put(`${state}/runner.json`, {
    pid, at: new Date(now).toISOString(), every: 15, error: null,
    waiting: [
      { issue: 102, stage: 'build', on: 'quota' },
      { issue: 105, stage: 'pr', on: 'ci' },
      { issue: 108, stage: 'merged', on: 'owner' },
    ],
    quota: {
      claude: { h5: 41, week: 388, limitedUntil: null },
      codex: { h5: 12, week: 97, limitedUntil: new Date(now + 47 * 60e3).toISOString() },
    },
  });
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, pid] = process.argv.slice(2);
  console.log(seed(dir ? resolve(dir) : undefined, pid ? { pid: Number(pid) } : {}));
}
