function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Lightweight markdown → HTML (mirrors WeChat mini program's markdownToHtml).
 *  Outputs safe HTML subset: h1-6, p, ul/ol, pre/code, blockquote, hr,
 *  inline strong/em/code, and ASCII/Markdown tables. */
export function markdownToHtml(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  let listType: 'ul' | 'ol' | null = null;

  const flushList = () => {
    if (inList) {
      out.push(listType === 'ol' ? '</ol>' : '</ul>');
      inList = false;
      listType = null;
    }
  };

  for (const raw of lines) {
    if (raw.trimStart().startsWith('```')) {
      flushList();
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        out.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(raw));
      continue;
    }

    let line = raw.trim();

    const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      flushList();
      const level = hMatch[1].length;
      out.push(`<h${level}>${escapeHtml(hMatch[2])}</h${level}>`);
      continue;
    }

    if (/^[-*_]{3,}$/.test(line)) {
      flushList();
      out.push('<hr>');
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      if (!inList || listType !== 'ul') { flushList(); out.push('<ul>'); inList = true; listType = 'ul'; }
      out.push(`<li>${escapeHtml(line.replace(/^[-*+]\s+/, ''))}</li>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      if (!inList || listType !== 'ol') { flushList(); out.push('<ol>'); inList = true; listType = 'ol'; }
      out.push(`<li>${escapeHtml(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushList();
      out.push(`<blockquote>${escapeHtml(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    if (/^[\|+][-+\s|:]*[\|+]/.test(line) && line.includes('|')) {
      flushList();
      if (/^\+/.test(line)) continue;
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
      if (cells.length === 0) continue;
      const isFirstRow = !out.length || !out[out.length - 1].includes('flex-direction:row');
      const bg = isFirstRow ? 'background:#f5f5f4;font-weight:700' : '';
      out.push('<div style="display:flex;flex-direction:row;width:100%">');
      for (const c of cells) {
        out.push(`<div style="flex:1;min-width:0;padding:4px 6px;border:1px solid #d1d5db;font-size:13px;word-break:break-word;${bg}">${escapeHtml(c)}</div>`);
      }
      out.push('</div>');
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      flushList();
      if (/^\|[\s:-]+\|$/.test(line)) continue;
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
      const isFirstRow = !out.length || !out[out.length - 1].includes('flex-direction:row');
      const bg = isFirstRow ? 'background:#f5f5f4;font-weight:700' : '';
      out.push('<div style="display:flex;flex-direction:row;width:100%">');
      for (const c of cells) {
        out.push(`<div style="flex:1;min-width:0;padding:4px 6px;border:1px solid #d1d5db;font-size:13px;word-break:break-word;${bg}">${escapeHtml(c)}</div>`);
      }
      out.push('</div>');
      continue;
    }

    if (line) {
      flushList();
      let html = escapeHtml(line)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
      out.push(`<p>${html}</p>`);
    } else if (out.length > 0) {
      flushList();
    }
  }

  flushList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}
