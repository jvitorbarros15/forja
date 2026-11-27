import fs from 'node:fs';

const argv = process.argv.slice(2);
let stdin = '';
for await (const c of process.stdin) stdin += c;
const rec = { argv, stdin, cwd: process.cwd() };
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(rec)}\n`);
if (process.env.FAKE_LIMIT) { console.error('429 rate limit'); process.exit(1); }
const text = JSON.stringify(rec);

if (argv[0] === 'exec') {
  fs.writeFileSync(argv[argv.indexOf('-o') + 1], text);
  console.log(JSON.stringify({ type: 'thread.started' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } }));
} else if (argv.includes('--restricted')) {
  console.log(JSON.stringify({ type: 'result', result: text, usage: { input_tokens: 3, output_tokens: 4 } }));
} else if (argv.includes('--mode')) {
  console.log(JSON.stringify({ status: 'SUCCESS', response: text, stats: { promptTokenCount: 7, candidatesTokenCount: 3 } }));
} else {
  console.log(JSON.stringify({ response: text, stats: { models: { m: { tokens: { prompt: 10, candidates: 5, total: 15 } } } } }));
}
