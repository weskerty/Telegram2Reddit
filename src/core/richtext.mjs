/**
 * @typedef {{ text: string; url?: string }} RichSegment
 * @typedef {RichSegment[]} RichLine
 * @typedef {RichLine[]} RichParagraph
 */

/**
 * Split rendered markdown into paragraphs → lines → text/link segments, so the
 * server can rebuild it as Reddit richtext (needed to embed uploaded media).
 * Only `[label](url)` links are kept as structure.
 *
 * @param {string} markdown
 * @returns {RichParagraph[]}
 */
export function markdownToRichParagraphs(markdown) {
  return String(markdown || "")
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .map(parseMarkdownLine)
        .filter((segments) => segments.length > 0)
    )
    .filter((lines) => lines.length > 0);
}

/**
 * @param {string} line
 * @returns {RichSegment[]}
 */
function parseMarkdownLine(line) {
  /** @type {RichSegment[]} */
  const segments = [];
  let lastIndex = 0;
  for (const match of line.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index) });
    }
    segments.push({ text: match[1] || match[2], url: match[2] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex) });
  }
  return segments.some((segment) => segment.text.trim() !== "") ? segments : [];
}
