// Renders a report as a small two-segment SVG badge: `crashtest` on the left, the stars and eve version on the right.
import type { Report, Stars } from "../types.ts";
import { commitLabel, reportDate, starString } from "./format.ts";

const HEIGHT = 20;
const LEFT_TEXT = "crashtest";
const LEFT_COLOR = "#555";
const NOT_EVALUATED_COLOR = "#9f9f9f";
const STAR_COLORS: Record<Stars, string> = { 5: "#2ea44f", 4: "#97ca00", 3: "#dfb317", 2: "#fe7d37", 1: "#e05d44" };
const FONT = "Verdana,Geneva,DejaVu Sans,sans-serif";

/** Segment width: 12 px of padding plus 7 px per character. */
const segmentWidth = (text: string): number => 12 + 7 * [...text].length;

/** Text that is safe inside an element or a double-quoted attribute. */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The full description of the badge, for screen readers and the hover title: the rating and how many tools it covers. */
function description(r: Report): string {
  const { stars, evaluated, total } = r.agent;
  const rating = stars === null ? "not evaluated" : `${stars}/5 stars`;
  return `crashtest: ${rating} · ${evaluated} of ${total} tools evaluated · eve ${r.eve.version} · commit ${commitLabel(r.target)} · ${reportDate(r)} · in lab, ${r.lab.cells} cells`;
}

/** Centered text with a soft shadow, so it stays readable on the light segment colors. */
function label(content: string, x: number): string {
  const text = escapeXml(content);
  return `<text x="${x}" y="15" fill="#010101" fill-opacity=".3">${text}</text>\n    <text x="${x}" y="14">${text}</text>`;
}

export function renderBadge(r: Report): string {
  const { stars } = r.agent;
  const rightText = stars === null ? "not evaluated" : `${starString(stars)} eve ${r.eve.version}`;
  const rightColor = stars === null ? NOT_EVALUATED_COLOR : STAR_COLORS[stars];
  const left = segmentWidth(LEFT_TEXT);
  const right = segmentWidth(rightText);
  const width = left + right;
  const title = escapeXml(description(r));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" role="img" aria-label="${title}">
  <title>${title}</title>
  <clipPath id="round"><rect width="${width}" height="${HEIGHT}" rx="3"/></clipPath>
  <g clip-path="url(#round)">
    <rect width="${left}" height="${HEIGHT}" fill="${LEFT_COLOR}"/>
    <rect x="${left}" width="${right}" height="${HEIGHT}" fill="${rightColor}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="${FONT}" font-size="11">
    ${label(LEFT_TEXT, left / 2)}
    ${label(rightText, left + right / 2)}
  </g>
</svg>
`;
}
