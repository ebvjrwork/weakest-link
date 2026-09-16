// Client-side question parsing, used only for instant preview UX (the "found
// N questions — use these?" step). The server always re-parses/validates
// from raw text/CSV independently before anything becomes authoritative —
// never trust this output as-is for game state.

export function parseCSVQuestions(text) {
  text = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++; continue;
    }
  }
  row.push(field);
  rows.push(row);

  const out = [];
  rows.forEach((r, idx) => {
    const q = (r[0] || '').trim();
    const a = (r[1] || '').trim();
    if (!q || !a) return;
    if (idx === 0 && /^question$/i.test(q) && /^answer$/i.test(a)) return;
    out.push([q, a]);
  });
  return out;
}

export function parseCustomQuestions(text) {
  text = (text || '').trim();
  if (!text) return [];
  if (text[0] === '[') {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        const fromJson = [];
        arr.forEach((item) => {
          if (Array.isArray(item) && item[0] && item[1]) {
            fromJson.push([String(item[0]).trim(), String(item[1]).trim()]);
          } else if (item && typeof item === 'object') {
            const q = item.q || item.question;
            const a = item.a || item.answer;
            if (q && a) fromJson.push([String(q).trim(), String(a).trim()]);
          }
        });
        if (fromJson.length) return fromJson;
      }
    } catch (e) { /* not valid JSON, fall through to line parsing */ }
  }
  const out = [];
  text.split('\n').forEach((line) => {
    line = line.trim();
    if (!line) return;
    const idx = line.indexOf('|');
    if (idx === -1) return;
    const q = line.slice(0, idx).trim();
    const a = line.slice(idx + 1).trim();
    if (q && a) out.push([q, a]);
  });
  return out;
}

// pairs -> [{q,a}, ...] objects, matching the server's wire format.
export function pairsToObjects(pairs) {
  return pairs.map(([q, a]) => ({ q, a }));
}
