/**
 * Prose that reaches GitHub check summaries, annotations and pull-request comments is rendered
 * as Markdown: a finding message quoting repository code could @mention a stranger, link an
 * unrelated issue, or smuggle a disguised link or raw HTML (which also breaks webhook relays
 * that re-encode the body). This neutralizes that text without hiding it: it still reads the
 * same on the page. Fenced suggestion code and file paths are never passed through here.
 */
export function githubText(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // "@name" pings that GitHub user; a zero-width space keeps the text readable but unlinked.
      .replace(/@(?=[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\b)/g, '@​')
      // "#123" auto-links the repository's own issue or pull request.
      .replace(/(?<![\w/])#(?=\d)/g, '#​')
      // "[" and "]" open links, images and reference-style markup.
      .replace(/\[/g, '\\[')
      .replace(/]/g, '\\]')
  );
}
