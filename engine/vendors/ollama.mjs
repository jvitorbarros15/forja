import fs from 'node:fs';

export async function run(vcfg, model, { prompt, images = [], timeoutMs = 120e3 }) {
  try {
    const res = await fetch(`${vcfg.url.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt, ...(images.length ? { images: images.map((i) => fs.readFileSync(i).toString('base64')) } : {}) }] }),
    });
    const body = await res.text();
    if (!res.ok) return { code: res.status, out: body, err: `ollama ${res.status} ${body.slice(0, 300)}`, text: '', usage: null };
    const j = JSON.parse(body), input = j.prompt_eval_count ?? 0, output = j.eval_count ?? 0;
    return { code: 0, out: body, err: '', text: j.message?.content ?? '', usage: input || output ? { input, output, total: input + output } : null };
  } catch (e) { return { code: -1, out: '', err: String(e), text: '', usage: null }; }
}
