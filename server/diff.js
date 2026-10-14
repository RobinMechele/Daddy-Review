'use strict';
/**
 * Line diff for the review screen (Myers' algorithm on the part that differs).
 * Returns every line of the file, marked as unchanged, removed or added, so the
 * UI can fold long unchanged stretches and unfold them without asking again.
 */

const MAX_LINES = 20000;
const MAX_EDITS = 1500;

/** Split text into lines (no trailing empty line for a final newline). */
function splitLines(text) {
  if (!text) return [];
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Does this look like a binary file (a NUL byte near the start)? */
function isBinary(buf) {
  if (!buf || !buf.length) return false;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Shortest edit script between two arrays of numbers.
 * Returns [['=', i, j] | ['-', i] | ['+', j]] or null when they differ too much.
 */
function myers(a, b, maxD = MAX_EDITS) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((_, j) => ['+', j]);
  if (!m) return a.map((_, i) => ['-', i]);
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  outer:
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        found = d;
        break outer;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const get = (kk) => prev[kk + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push(['=', x, y]); }
    if (x === prevX) { y--; ops.push(['+', y]); } else { x--; ops.push(['-', x]); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push(['=', x, y]); }
  return ops.reverse();
}

/**
 * Diff two texts. Result: { lines: [{ t: ' ' | '-' | '+', o, n, s }], added, removed }
 * (o/n are 1-based line numbers in the old/new file), or { tooLarge: true }.
 */
function diffText(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_LINES || b.length > MAX_LINES) return { tooLarge: true };
  // Lines become numbers so comparing is cheap.
  const ids = new Map();
  const id = (s) => {
    let v = ids.get(s);
    if (v === undefined) { v = ids.size; ids.set(s, v); }
    return v;
  };
  const ai = a.map(id);
  const bi = b.map(id);
  let start = 0;
  while (start < ai.length && start < bi.length && ai[start] === bi[start]) start++;
  let endA = ai.length;
  let endB = bi.length;
  while (endA > start && endB > start && ai[endA - 1] === bi[endB - 1]) { endA--; endB--; }

  const midA = ai.slice(start, endA);
  const midB = bi.slice(start, endB);
  // Too different to line up: everything in between was replaced.
  const ops = myers(midA, midB) || [...midA.map((_, i) => ['-', i]), ...midB.map((_, j) => ['+', j])];

  const lines = [];
  for (let i = 0; i < start; i++) lines.push({ t: ' ', o: i + 1, n: i + 1, s: a[i] });
  for (const op of ops) {
    if (op[0] === '=') lines.push({ t: ' ', o: start + op[1] + 1, n: start + op[2] + 1, s: a[start + op[1]] });
    else if (op[0] === '-') lines.push({ t: '-', o: start + op[1] + 1, n: null, s: a[start + op[1]] });
    else lines.push({ t: '+', o: null, n: start + op[1] + 1, s: b[start + op[1]] });
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) lines.push({ t: ' ', o: i + 1, n: j + 1, s: a[i] });
  // Show removals before additions within a changed block.
  for (let i = 0; i < lines.length;) {
    if (lines[i].t === ' ') { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].t !== ' ') j++;
    const block = lines.slice(i, j);
    const sorted = [...block.filter((l) => l.t === '-'), ...block.filter((l) => l.t === '+')];
    lines.splice(i, block.length, ...sorted);
    i = j;
  }
  return {
    lines,
    added: lines.filter((l) => l.t === '+').length,
    removed: lines.filter((l) => l.t === '-').length,
  };
}

module.exports = { diffText, splitLines, isBinary, myers };
