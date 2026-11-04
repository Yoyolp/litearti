/**
 * The stylesheet injected into the iframe in reflow mode.
 *
 * It is generated at runtime rather than imported as a static .css file for
 * one reason: the values come from the app's design tokens, and the iframe is
 * a separate document that cannot see `:root` of the parent. Reading the
 * computed tokens once and baking them into the injected sheet keeps a single
 * source of truth — the numbers still live only in `tokens.css`.
 */

/** Tokens the reading surface needs, with the fallback each one must have. */
const TOKEN_NAMES = [
  '--ink-primary',
  '--ink-secondary',
  '--ink-tertiary',
  '--surface-page',
  '--surface-sunken',
  '--line-subtle',
  '--line-strong',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
  '--text-sm',
  '--text-base',
  '--text-md',
  '--text-lg',
  '--text-xl',
  '--weight-strong',
  '--leading-relaxed',
  '--measure-prose',
  '--radius-sm',
] as const

function readTokens(host: Element): Record<string, string> {
  const styles = getComputedStyle(host)
  const out: Record<string, string> = {}
  for (const name of TOKEN_NAMES) {
    const value = styles.getPropertyValue(name).trim()
    if (value) out[name] = value
  }
  return out
}

/**
 * Build the reflow stylesheet.
 *
 * `fontSize` is the reader's own control (13–28px), matching the text viewer's
 * range so the two formats feel like the same application.
 */
export function buildReflowCss(host: Element, fontSize: number): string {
  const token = readTokens(host)
  const v = (name: string, fallback: string): string => token[name] ?? fallback

  return `
    html {
      background: ${v('--surface-page', '#fafafa')};
      color: ${v('--ink-primary', '#1c1c1c')};
      font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
      font-size: ${fontSize}px;
      line-height: ${v('--leading-relaxed', '1.9')};
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      overflow-wrap: break-word;
    }

    body {
      margin: 0;
      padding: ${v('--space-6', '32px')} ${v('--space-6', '32px')} ${v('--space-7', '48px')};
      max-width: calc(${v('--measure-prose', '34em')} + ${v('--space-6', '32px')} * 2);
      margin-inline: auto;
      /* Body text is selectable; the shell already sets this globally, but the
         iframe is a separate document and needs its own rule. */
      user-select: text;
    }

    /* Every block gets one rhythm step; the space between groups is always
       larger than the space inside them. */
    p, blockquote, ul, ol, pre, table, figure {
      margin: 0 0 ${v('--space-4', '16px')};
    }

    h1, h2, h3, h4, h5, h6 {
      margin: ${v('--space-6', '32px')} 0 ${v('--space-3', '12px')};
      line-height: 1.35;
      font-weight: ${v('--weight-strong', '600')};
      color: ${v('--ink-primary', '#1c1c1c')};
      break-after: avoid;
    }
    h1 { font-size: ${v('--text-xl', '24px')}; }
    h2 { font-size: ${v('--text-lg', '20px')}; }
    h3 { font-size: ${v('--text-md', '17px')}; }
    h4, h5, h6 { font-size: ${v('--text-base', '15px')}; }

    /* A chapter's first heading should not push the text down a whole screen. */
    body > h1:first-child,
    body > h2:first-child,
    body > h3:first-child {
      margin-top: 0;
    }

    blockquote {
      padding-left: ${v('--space-4', '16px')};
      border-left: 2px solid ${v('--line-strong', '#d6d6d6')};
      color: ${v('--ink-secondary', '#6b6b6b')};
    }

    ul, ol { padding-left: ${v('--space-5', '24px')}; }
    li { margin-bottom: ${v('--space-2', '8px')}; }

    a[data-epub-href] {
      color: inherit;
      text-decoration: underline;
      text-decoration-color: ${v('--line-strong', '#d6d6d6')};
      text-underline-offset: 2px;
      cursor: pointer;
    }

    img, svg, video {
      max-width: 100%;
      height: auto;
      display: block;
      margin: ${v('--space-4', '16px')} auto;
    }

    figure { text-align: center; }
    figcaption {
      font-size: ${v('--text-sm', '13px')};
      color: ${v('--ink-tertiary', '#9a9a9a')};
      margin-top: ${v('--space-2', '8px')};
    }

    pre {
      background: ${v('--surface-sunken', '#f2f2f2')};
      padding: ${v('--space-4', '16px')};
      border-radius: ${v('--radius-sm', '6px')};
      overflow-x: auto;
      font-size: ${v('--text-sm', '13px')};
      line-height: 1.6;
    }
    code { font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace; }
    pre code { font-size: inherit; }

    table {
      border-collapse: collapse;
      width: 100%;
      font-size: ${v('--text-sm', '13px')};
      display: block;
      overflow-x: auto;
    }
    th, td {
      padding: ${v('--space-2', '8px')} ${v('--space-3', '12px')};
      border-bottom: 1px solid ${v('--line-subtle', '#ebebeb')};
      text-align: left;
    }
    th { font-weight: ${v('--weight-strong', '600')}; }

    hr {
      border: none;
      border-top: 1px solid ${v('--line-subtle', '#ebebeb')};
      margin: ${v('--space-6', '32px')} 0;
    }

    /* Footnote anchors and other empty links should not open a gap. */
    sup { line-height: 0; }
    :target { scroll-margin-top: ${v('--space-5', '24px')}; }
  `
}

/**
 * Stylesheet for fixed-layout books in "follow theme" mode.
 *
 * A pre-paginated page is a fixed canvas, so its colours cannot be reflowed.
 * What can be done is invert the page surface without touching layout, which
 * is what this does — and it is only applied when the reader asks for it.
 */
export function buildFixedThemeCss(host: Element): string {
  const token = readTokens(host)
  const v = (name: string, fallback: string): string => token[name] ?? fallback
  return `
    html {
      background: ${v('--surface-page', '#fafafa')};
    }
    body {
      background: ${v('--surface-page', '#fafafa')};
      color: ${v('--ink-primary', '#1c1c1c')};
    }
  `
}
