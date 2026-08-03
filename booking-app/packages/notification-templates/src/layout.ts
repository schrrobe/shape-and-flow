import { escapeHtml } from './format.js';

import type { CommonData, Locale } from './types.js';

/**
 * The palette, inline.
 *
 * Email clients strip `<style>` blocks and know nothing of CSS custom properties, so
 * every colour is repeated at each use site. That is not a shortcut — it is the only
 * thing that renders consistently in Outlook, and a stylesheet here would silently
 * degrade to unstyled text.
 */
const COLOURS = {
  paper: '#f5f0e6',
  ink: '#1c1c1c',
  accent: '#d2691e',
  muted: '#6b6b6b',
  rule: '#e0d8c8',
} as const;

const FOOTER: Record<Locale, (data: CommonData) => string> = {
  de: (data) =>
    `${data.businessName} · ${data.addressLine} · ${data.businessPhone}\n` +
    `Diese Nachricht wurde automatisch versendet. Antworten erreichen uns unter ${data.businessEmail}.`,
  en: (data) =>
    `${data.businessName} · ${data.addressLine} · ${data.businessPhone}\n` +
    `This message was sent automatically. Replies reach us at ${data.businessEmail}.`,
};

/**
 * Wrap body paragraphs in the email shell.
 *
 * Table-based, because that is what email clients lay out reliably — flexbox and grid are
 * not dependable across Outlook, and a broken confirmation email is worse than a plain
 * one.
 *
 * The plain-text sibling is generated from the same blocks rather than by stripping tags
 * from the HTML. Stripping produces text with the *shape* of markup — stray whitespace,
 * lost line breaks — and the text part is what a screen reader and a text-only client
 * actually read.
 */
export function renderLayout(
  blocks: readonly string[],
  data: CommonData,
  locale: Locale,
): { text: string; html: string } {
  const footer = FOOTER[locale](data);

  return {
    text: `${blocks.join('\n\n')}\n\n—\n${footer}`,
    html: htmlShell(blocks, footer, data.businessName),
  };
}

function htmlShell(blocks: readonly string[], footer: string, businessName: string): string {
  const paragraphs = blocks
    .map(
      (block) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${COLOURS.ink};">` +
        // Escaped here, once, at the boundary between data and markup. Newlines inside a
        // block become breaks so a template can format an address or a list.
        `${escapeHtml(block).replace(/\n/g, '<br />')}</p>`,
    )
    .join('');

  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLOURS.paper};margin:0;padding:24px 0;">`,
    '<tr><td align="center">',
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;">`,
    `<tr><td style="padding:24px 32px;border-bottom:3px solid ${COLOURS.accent};">`,
    `<span style="font-size:20px;font-weight:700;color:${COLOURS.ink};letter-spacing:0.02em;">${escapeHtml(businessName)}</span>`,
    '</td></tr>',
    `<tr><td style="padding:32px;">${paragraphs}</td></tr>`,
    `<tr><td style="padding:16px 32px 24px;border-top:1px solid ${COLOURS.rule};">`,
    `<span style="font-size:12px;line-height:1.5;color:${COLOURS.muted};">${escapeHtml(footer).replace(/\n/g, '<br />')}</span>`,
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
  ].join('');
}
