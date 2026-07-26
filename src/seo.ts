import type { FeedRow } from './db.js';

/**
 * Crawler-facing rendering: robots.txt, sitemap.xml, llms.txt, and
 * server-side rendering of the issue list into index.html so search engines
 * (and AI crawlers, most of which do not execute JavaScript) see real
 * content instead of an empty shell. The client re-renders on load; the
 * markup below mirrors render() in public/index.html at rest (the bookmark
 * and ignore buttons are omitted: they are invisible until hover and need
 * JS state anyway).
 */

export const SITE = 'https://opensourcefeed.dev';

/** Display names for language landing pages (/python, /rust, ...). */
const LANG_NAMES: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
};

export function langDisplayName(lang: string): string {
  return LANG_NAMES[lang] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

// Mirrors LANG_COLORS / LABEL_COLORS / starFmt / age in public/index.html.
const LANG_COLORS: Record<string, string> = {
  javascript: '#f1e05a', typescript: '#3178c6', python: '#3572a5',
  go: '#00add8', rust: '#dea584', java: '#b07219',
};
const LABEL_COLORS: Record<string, string> = {
  'bug': '#dc2626', 'good first issue': '#2563eb', 'help wanted': '#d97706',
  'enhancement': '#16a34a', 'documentation': '#7c3aed', 'docs': '#7c3aed',
};
const ICON_STAR = '<svg viewBox="0 0 16 16"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z"/></svg>';
const ICON_COMMENT = '<svg viewBox="0 0 16 16"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';

function starFmt(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
}

function age(created: Date): string {
  const s = Math.max(0, (Date.now() - created.getTime()) / 1000);
  if (s < 90) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

function renderIssueLi(i: FeedRow): string {
  const repoUrl = 'https://github.com/' + i.repo_full_name;
  const langColor = LANG_COLORS[i.language] ?? '#8b949e';
  const createdIso = i.created_at.toISOString();
  const pills = i.labels.map((l) => {
    const c = LABEL_COLORS[l.toLowerCase()] ?? '#6b7280';
    return `<button class="pill label-chip" data-label="${escHtml(l)}"
        style="color:${c};background:color-mix(in srgb, ${c} 12%, var(--bg))">${escHtml(l)}</button>`;
  }).join('');
  return `
      <li class="issue" data-id="${escHtml(i.id)}" data-repo="${escHtml(i.repo_full_name)}">
        <div class="row-main">
          <div class="title-line">
            <a href="${escHtml(i.url)}" target="_blank" rel="noopener">${escHtml(i.title)}</a>
          </div>
          <div class="meta">
            <span class="lang"><i style="background:${langColor}"></i>${escHtml(i.language)}</span>
            <a class="repo" href="${escHtml(repoUrl)}" target="_blank" rel="noopener" title="open repository">${escHtml(i.repo_full_name)}#${i.number}</a>
            <span class="stars">${ICON_STAR}${starFmt(i.repo_stars)}</span>
            ${pills}
          </div>
        </div>
        <div class="row-side">
          <span class="age" data-created="${createdIso}" title="${createdIso}">${age(i.created_at)}</span>
          <span class="comments${i.comments > 0 ? ' has' : ''}">${ICON_COMMENT}${i.comments}</span>
        </div>
      </li>`;
}

export interface PageOpts {
  /** Language slug when rendering a /:lang landing page. */
  lang?: string;
}

/**
 * Inject server-rendered issues (and, for language pages, page-specific
 * title/description/canonical plus an intro line) into the index.html
 * template. All replacements target exact strings present in the template;
 * if the template drifts, the replace is a no-op and the page still works
 * as the plain client-rendered app.
 */
export function renderAppPage(template: string, issues: FeedRow[], opts: PageOpts = {}): string {
  let html = template;

  const jsonLd: Record<string, unknown>[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'open source feed',
      url: SITE + '/',
      description:
        'Live feed of fresh, unassigned open-source GitHub issues from popular repositories, verified claimable.',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'open source feed',
      url: SITE + '/',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      description:
        'Find GitHub issues to contribute to minutes after they open: unassigned, in 100-star-plus repositories, with no pull request already on the way.',
    },
  ];

  if (opts.lang) {
    const name = langDisplayName(opts.lang);
    const url = `${SITE}/${opts.lang}`;
    const title = `Fresh ${name} open source issues to contribute to · open source feed`;
    const desc =
      `Live feed of fresh, unassigned ${name} issues from popular GitHub repositories ` +
      `(100 stars or more), updated every few minutes and verified claimable: open, ` +
      `unassigned, and no pull request on the way.`;
    html = html
      .replace(
        /<title>[^<]*<\/title>/,
        `<title>${escHtml(title)}</title>`
      )
      .replace(
        /<meta name="description" content="[^"]*">/,
        `<meta name="description" content="${escHtml(desc)}">`
      )
      .replace(
        /<meta property="og:title" content="[^"]*">/,
        `<meta property="og:title" content="${escHtml(title)}">`
      )
      .replace(
        /<meta property="og:description" content="[^"]*">/,
        `<meta property="og:description" content="${escHtml(desc)}">`
      )
      .replace(
        /<meta property="og:url" content="[^"]*">/,
        `<meta property="og:url" content="${url}/">`
      )
      .replace(
        /<link rel="canonical" href="[^"]*">/,
        `<link rel="canonical" href="${url}">`
      )
      // The frontend reads this to preselect the language filter.
      .replace('<html lang="en">', `<html lang="en" data-preset-language="${escHtml(opts.lang)}">`)
      // Crawler-visible page intro, styled by .page-intro in the template.
      .replace(
        '<ul id="list">',
        `<p class="page-intro">Fresh ${escHtml(name)} issues from popular open source ` +
          `repositories: open, unassigned, and nobody is working on them yet. ` +
          `Updated every few minutes.</p>\n    <ul id="list">`
      );
  }

  html = html
    .replace('<ul id="list"></ul>', `<ul id="list">${issues.map(renderIssueLi).join('')}\n    </ul>`)
    .replace('</head>', `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n</head>`);

  return html;
}

export function robotsTxt(): string {
  // Everything public is crawlable, including by AI crawlers (GPTBot,
  // ClaudeBot, PerplexityBot, Google-Extended and friends fall under *).
  return `User-agent: *
Allow: /
Disallow: /internal/

Sitemap: ${SITE}/sitemap.xml
`;
}

export function sitemapXml(languages: string[]): string {
  const urls: Array<{ loc: string; changefreq: string }> = [
    { loc: `${SITE}/`, changefreq: 'hourly' },
    ...languages.map((l) => ({ loc: `${SITE}/${l}`, changefreq: 'hourly' })),
    { loc: `${SITE}/guide`, changefreq: 'monthly' },
    { loc: `${SITE}/about`, changefreq: 'monthly' },
  ];
  const body = urls
    .map((u) => `  <url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

/** llms.txt: a plain-language site summary for AI crawlers (llmstxt.org). */
export function llmsTxt(languages: string[]): string {
  const langList = languages.map(langDisplayName).join(', ');
  return `# open source feed

> Live feed of fresh, unassigned open-source GitHub issues from popular
> repositories (100 stars or more). Every listed issue is verified claimable:
> open, unassigned, and with no pull request already linked to close it.
> Issues appear minutes after they are opened and expire after five days,
> so everything shown is recent enough to be worth claiming.

Languages covered: ${langList}.

## Pages

- [Feed](${SITE}/): the live issue feed with filters for language, stars, labels and full-text search
${languages.map((l) => `- [${langDisplayName(l)} issues](${SITE}/${l}): fresh ${langDisplayName(l)} issues only`).join('\n')}
- [Guide](${SITE}/guide): how to find open source issues that are actually available, and how to claim one
- [About](${SITE}/about): why the feed exists and how the pipeline works
- [Atom feed](${SITE}/feed.xml): RSS/Atom, accepts the same filters as the page

## For contributors

Use this site to find GitHub issues to work on before they are taken:
good first issues, help wanted issues, bugs and documentation tasks in
JavaScript, TypeScript, Python, Go, Rust and Java projects.
`;
}