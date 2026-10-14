import { esc } from './util.js';

/**
 * A small, safe Markdown renderer for PR descriptions and comments: everything
 * is escaped first, then a few constructs are turned into HTML. Links only to
 * http(s) and they open in your browser.
 */

const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : null);

function inline(text) {
  // Code spans first, so nothing inside them gets formatted.
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  // Images need a sign-in to load; show them as links.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const u = safeUrl(url.replace(/&amp;/g, '&'));
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">🖼 ${alt || 'image'}</a>` : m;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const u = safeUrl(url.replace(/&amp;/g, '&'));
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  // Azure DevOps mentions look like @<GUID>.
  s = s.replace(/@&lt;[0-9A-Fa-f-]{36}&gt;/g, '<span class="mention">@someone</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

export function md(src) {
  const text = String(src || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  const out = [];
  const parts = text.split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const line of part.split('\n')) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const ul = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      const quote = /^>\s?(.*)$/.exec(line);
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if (h) { flushPara(); flushList(); out.push(`<h${Math.min(6, h[1].length + 3)}>${inline(h[2])}</h${Math.min(6, h[1].length + 3)}>`); continue; }
      if (ul || ol) {
        flushPara();
        const tag = ul ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((ul || ol)[1]);
        continue;
      }
      if (quote) { flushPara(); flushList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
      flushList();
      para.push(line);
    }
    flushPara();
    flushList();
  });
  return out.join('');
}
