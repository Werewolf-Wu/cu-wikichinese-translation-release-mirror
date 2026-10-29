import { Marked, type Tokens } from 'marked';
import sanitizeHtml from 'sanitize-html';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);

function webUrl(href: string): URL | undefined {
  try {
    const url = new URL(href);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch { return undefined; }
}

/** Shorten bare GitHub URLs only; authored link labels and destination URLs stay intact. */
function githubLabel(url: URL, sourceUrl?: string): string | undefined {
  if (url.hostname !== 'github.com' || url.search || url.hash) return undefined;
  const [, owner, repo, kind, value, ...rest] = url.pathname.split('/');
  if (!owner || !repo || !value || rest.length) return undefined;
  const source = sourceUrl ? webUrl(sourceUrl) : undefined;
  const sameRepo = source?.hostname === 'github.com'
    && source.pathname.toLowerCase().startsWith(`/${owner}/${repo}/`.toLowerCase());
  const prefix = sameRepo ? '' : `${owner}/${repo} · `;
  if (kind === 'pull' && /^\d+$/.test(value)) return `${prefix}PR #${value}`;
  if (kind === 'issues' && /^\d+$/.test(value)) return `${prefix}Issue #${value}`;
  if (kind === 'compare' && value.includes('...')) return `${prefix}版本对比`;
  if (kind === 'commit' && /^[0-9a-f]{7,40}$/i.test(value)) return `${prefix}${value.slice(0, 7)}`;
  return undefined;
}

/** Build-time Markdown only: literal raw HTML, no embedded images, allowlisted output. */
export function renderReleaseNotes(markdown: string, sourceUrl?: string): string {
  const parser = new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const level = depth <= 2 ? 5 : 6;
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) { return escapeHtml(text); },
      link({ href, title, tokens }: Tokens.Link) {
        const content = this.parser.parseInline(tokens);
        const url = webUrl(href);
        if (!url) return content;
        const bare = tokens.length === 1 && tokens[0].type === 'text' && tokens[0].text === href;
        const short = bare ? githubLabel(url, sourceUrl) : undefined;
        return `<a href="${escapeHtml(url.href)}" title="${escapeHtml(title || url.href)}">${short ? escapeHtml(short) : content}</a>`;
      },
      image({ href, text }: Tokens.Image) {
        const label = escapeHtml(text ? `图片：${text}` : '查看图片');
        const url = webUrl(href);
        return url ? `<a href="${escapeHtml(url.href)}">${label}</a>` : label;
      },
    },
  });
  const html = parser.parse(markdown.trim() || '早期版本，更新记录暂缺。', { async: false });
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'blockquote', 'pre', 'code', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    allowedAttributes: { a: ['href', 'title'], ol: ['start'], input: ['type', 'disabled', 'checked'] },
    allowedSchemes: ['https', 'http'],
    allowProtocolRelative: false,
    // GFM task checkboxes are static release content, never interactive forms.
    transformTags: { input: (_tagName, attrs) => ({ tagName: 'input', attribs: { type: 'checkbox', disabled: '', ...('checked' in attrs ? { checked: '' } : {}) } }) },
  });
}
