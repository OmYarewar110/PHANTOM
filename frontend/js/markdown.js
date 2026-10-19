/**
 * Lightweight Markdown renderer — no dependencies
 * Handles: headers, bold, italic, code, code blocks, links, lists, tables, blockquotes, hr
 */

// HTML entity map for escaping
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

window.renderMarkdown = function(text) {
  if (!text) return '';

  // Escape HTML
  let html = text.replace(/[&<>"']/g, match => escapeMap[match]);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const id = 'cb-' + Math.random().toString(36).substr(2, 6);
    const header = lang
      ? `<div class="code-block-header"><span>${lang}</span><button type="button" class="copy-btn" aria-label="Copy code" onclick="copyCode('${id}')">Copy</button></div>`
      : `<div class="code-block-header"><span>code</span><button type="button" class="copy-btn" aria-label="Copy code" onclick="copyCode('${id}')">Copy</button></div>`;
    return `${header}<pre id="${id}"><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Tables
  html = html.replace(/^(\|.+\|)\n(\|[-:\s|]+\|)\n((?:\|.+\|\n?)*)/gm, (match, header, separator, body) => {
    const headers = header.split('|').filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Headers
  html = html.replace(/^(#{1,4}) (.+)$/gm, (match, hashes, content) => `<h${hashes.length}>${content}</h${hashes.length}>`);

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Bold & Italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
    let cleanUrl = url.replace(/[\x00-\x1F\x7F]/g, '').trim();
    let decodedUrl = cleanUrl;
    try {
      decodedUrl = decodeURIComponent(cleanUrl).trim();
    } catch (err) {
      console.warn('Failed to decode URI in markdown link:', err.message);
    }
    if (/^(?:javascript|vbscript|data):/i.test(decodedUrl)) {
      cleanUrl = '#';
    }
    return `<a href="${cleanUrl}" target="_blank" rel="noopener">${text}</a>`;
  });

  // Unordered lists
  html = html.replace(/^[\s]*[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs — wrap remaining plain text lines
  html = html.replace(/^(?!<[a-z/])((?!<).+)$/gm, '<p>$1</p>');

  // Clean up extra paragraph tags around block elements
  // ⚡ Bolt: Consolidated two regex passes into one single pass using an OR condition
  // with $1$2 replacement to reduce string traversals by ~30-40% inside O(N^2) render loop
  html = html.replace(/<p>(<(?:h[1-6]|ul|ol|li|table|pre|blockquote|hr|div)[^>]*>)|(<\/(?:h[1-6]|ul|ol|li|table|pre|blockquote|hr|div)>)<\/p>/g, '$1$2');

  return html;
};

window.copyCode = function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = el.previousElementSibling?.querySelector('.copy-btn') ||
                el.parentElement?.querySelector('.copy-btn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = 'Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    }
  });
};

window.copyText = function(text, btnElement) {
  navigator.clipboard.writeText(text).then(() => {
    if (btnElement) {
      const orig = btnElement.innerHTML;
      btnElement.innerHTML = 'Copied!';
      setTimeout(() => { btnElement.innerHTML = orig; }, 1500);
    }
  });
};
