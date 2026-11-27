const KEYS = { input: /^(input_?tokens|prompt_?token_?count|prompt_?tokens)$/i, output: /^(output_?tokens|candidates_?token_?count|completion_?tokens)$/i, total: /^(total_?tokens|total_?token_?count)$/i };

// Sums every number found under a recognised key. Null when the CLI reports none.
export function usageOf(objs) {
  const u = { input: 0, output: 0, total: 0 };
  let seen = false;
  const walk = (o, key) => {
    if (o && typeof o === 'object') return Object.entries(o).forEach(([k, v]) => walk(v, k));
    for (const f in KEYS) if (typeof o === 'number' && KEYS[f].test(key ?? '')) { u[f] += o; seen = true; }
  };
  objs.forEach((o) => walk(o));
  if (!seen) return null;
  return { input: u.input, output: u.output, total: u.total || u.input + u.output };
}
