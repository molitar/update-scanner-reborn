import {highlightDiffs} from './diff_engine.js';

/**
 * Compare the two already-captured HTML snapshots.
 *
 * Rendering, scrolling, CSS collection, and lazy-content loading happen
 * during scan time. Viewing a stored page must never reopen the live site.
 *
 * @param {Page} page - Page object to diff.
 * @param {string} oldHtml - Previously stored rendered snapshot.
 * @param {string} newHtml - Most recently stored rendered snapshot.
 *
 * @returns {string} Highlighted stored HTML.
 */
function seedIsHighlight(el) {
  const style = (el.getAttribute("style") || "")
    .toLowerCase()
    .replace(/\s+/g, "");

  return (
    style.includes("background:#fff58a") ||
    style.includes("background-color:#fff58a") ||
    style.includes("background:rgb(255,245,138)") ||
    style.includes("background-color:rgb(255,245,138)") ||
    style.includes("background:rgba(255,245,138,1)") ||
    style.includes("background-color:rgba(255,245,138,1)")
  );
}

function injectAdaptiveHighlighting(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const highlighted = [...doc.querySelectorAll("[style]")].filter(seedIsHighlight);

  if (!highlighted.length) {
    return html || "";
  }

  highlighted.forEach(el => {
    el.setAttribute("data-updatescan-diff-highlight", "1");
    // Softer default for dark pages even if script execution is delayed/blocked.
    el.style.setProperty(
      "background-color",
      "rgba(255, 245, 120, 0.22)",
      "important",
    );
  });

  const style = doc.createElement("style");
  style.setAttribute("data-updatescan-adaptive-highlight-style", "1");
  style.textContent = `
    [data-updatescan-diff-highlight="1"] {
      transition: background-color 120ms linear, box-shadow 120ms linear;
    }
  `;
  doc.head.appendChild(style);

  const script = doc.createElement("script");
  script.setAttribute("data-updatescan-adaptive-highlight-script", "1");
  script.textContent = `(function () {
    function parseColor(input) {
      if (!input) return null;
      const value = input.trim().toLowerCase();

      if (
        !value ||
        value === "transparent" ||
        value === "rgba(0, 0, 0, 0)" ||
        value === "rgba(0,0,0,0)"
      ) {
        return null;
      }

      const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (hex) {
        let h = hex[1];
        if (h.length === 3) {
          h = h.split("").map(ch => ch + ch).join("");
        }
        return {
          r: parseInt(h.slice(0, 2), 16),
          g: parseInt(h.slice(2, 4), 16),
          b: parseInt(h.slice(4, 6), 16),
          a: 1,
        };
      }

      const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
      if (rgb) {
        const parts = rgb[1].split(",").map(x => x.trim());
        return {
          r: Math.max(0, Math.min(255, parseFloat(parts[0]) || 0)),
          g: Math.max(0, Math.min(255, parseFloat(parts[1]) || 0)),
          b: Math.max(0, Math.min(255, parseFloat(parts[2]) || 0)),
          a: parts.length > 3 ? Math.max(0, Math.min(1, parseFloat(parts[3]) || 0)) : 1,
        };
      }

      return null;
    }

    function effectiveBackground(el) {
      let node = el;
      while (node && node.nodeType === 1) {
        const color = parseColor(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0.01) {
          return color;
        }
        node = node.parentElement;
      }
      return {r: 255, g: 255, b: 255, a: 1};
    }

    function channelLuminance(value) {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }

    function luminance(color) {
      return (
        0.2126 * channelLuminance(color.r) +
        0.7152 * channelLuminance(color.g) +
        0.0722 * channelLuminance(color.b)
      );
    }

    function applyAdaptiveHighlights() {
      document.querySelectorAll('[data-updatescan-diff-highlight="1"]').forEach(el => {
        const bg = effectiveBackground(el.parentElement || el);
        const isDarkBackground = luminance(bg) < 0.48;

        el.style.setProperty(
          "background-color",
          isDarkBackground
            ? "#ffe36e"                     // clearly visible warm yellow on dark UI
            : "rgba(214, 170, 0, 0.45)",    // darker yellow on light UI
          "important",
        );

        if (isDarkBackground) {
          el.style.setProperty("color", "#111111", "important");
          el.style.setProperty("text-shadow", "none", "important");
          el.style.setProperty("border-radius", "2px", "important");
        }

        el.style.setProperty(
          "box-shadow",
          isDarkBackground
            ? "0 0 0 1px rgba(70, 55, 0, 0.65) inset, 0 0 0 1px rgba(255, 227, 110, 0.45)"
            : "0 0 0 1px rgba(133, 102, 0, 0.18) inset",
          "important",
        );
      });
    }

    const run = () => requestAnimationFrame(() => requestAnimationFrame(applyAdaptiveHighlights));

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, {once: true});
    } else {
      run();
    }
  })();`;

  (doc.body || doc.documentElement).appendChild(script);
  return doc.documentElement.outerHTML;
}

// Pages such as GitHub give every tooltip, menu and dialog a random ID
// (id="tooltip-3f2c9a1e-...", aria-describedby="...", for="...") that is new on
// every load. The diff compares markup as well as text, so those changing IDs
// made the words next to them (Star, Readme, Compare, ...) look changed. Inside
// ID-like attributes only, give every random ID the same value in both versions.
// UUIDs, long hashes, and the ids React generates for buttons and menus
// (":r1h:", "_r_2f_", "«r3»") that depend on the order things were drawn in.
const RANDOM_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}|:r[0-9a-z]{1,4}:|_r_[0-9a-z]{1,4}_|«r[0-9a-z]{1,4}»/gi;
const ID_ATTRIBUTE =
  /(\s(?:id|for|name|list|form|popovertarget|aria-[a-z]+|data-[a-z0-9-]+)\s*=\s*)("[^"]*"|'[^']*')/gi;

// Placeholder that stands in for every random id while the diff is computed. The
// displayed page must keep its real ids (carousels, tabs and menus link their
// controls to their panels by id), so the real values are put back afterwards.
const ID_PLACEHOLDER = '__updatescan_id__';
const ID_PLACEHOLDER_PATTERN = /__updatescan_id__/g;

/**
 * @param {string} html - A stored snapshot.
 *
 * @returns {{masked: string, originals: string[]}} The HTML with every random
 * id inside an ID-like attribute replaced by the same placeholder (so they
 * never show up as changes), and the original values in order of appearance.
 * Links, images and styles are left alone.
 */
export function maskRandomIds(html) {
  const originals = [];
  const masked = html.replace(ID_ATTRIBUTE, (match, name, value) =>
    name + value.replace(RANDOM_ID, (id) => {
      originals.push(id);
      return ID_PLACEHOLDER;
    }));
  return {masked, originals};
}

function restoreRandomIds(html, originals) {
  let next = 0;
  return html.replace(ID_PLACEHOLDER_PATTERN, () => originals[next++] || '');
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

const ENTITIES = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': '\'', '&nbsp;': ' '};

/**
 * @param {string} html - HTML.
 *
 * @returns {string} The visible text, with scripts, styles and tags removed
 * and whitespace collapsed.
 */
function visibleText(html) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
    .replace(/\s+/g, ' ')
    .trim();
}

function countOccurrences(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1;
    at = text.indexOf(needle, at + needle.length)) {
    count++;
  }
  return count;
}

const HIGHLIGHT_SPAN =
  /<span style="(text-decoration: line-through; )?background-color: #fff58a;">((?:(?!<\/span>)[\s\S])*)<\/span>/g;

/**
 * Safety net for the diff view. The diff compares markup as well as text, so
 * generated attributes it cannot recognise can still make unchanged words look
 * changed. A highlight on text that appears exactly as many times in the old
 * page as in the new one did not change, so drop it (a truly added or removed
 * word changes the count and keeps its highlight).
 *
 * @param {string} diffHtml - Output of the diff.
 * @param {string} oldHtml - Old snapshot.
 * @param {string} newHtml - New snapshot.
 *
 * @returns {string} The diff with those highlights removed.
 */
export function dropUnchangedHighlights(diffHtml, oldHtml, newHtml) {
  const oldText = visibleText(oldHtml);
  const newText = visibleText(newHtml);
  return diffHtml.replace(HIGHLIGHT_SPAN, (span, deleted, inner) => {
    const text = visibleText(inner);
    if (text === '') return span;
    const before = countOccurrences(oldText, text);
    const after = countOccurrences(newText, text);
    if (before === 0 || before !== after) return span;   // really changed
    // Unchanged: keep the text but not the highlight. Old text that merely
    // moved appears in the new page already, so a "deleted" copy is dropped.
    return deleted ? '' : inner;
  });
}

/**
 * List what the diff marked as changed, biggest first, so the Changes view can
 * say what changed (and why a page reports a large change).
 *
 * @param {string} diffHtml - Diff output, before the highlight styling is added.
 *
 * @returns {{count: number, characters: number, top: string[]}} How many places
 * are highlighted, how many characters that is, and the biggest few as short
 * snippets.
 */
export function summarizeHighlights(diffHtml) {
  const found = [];
  for (const match of diffHtml.matchAll(HIGHLIGHT_SPAN)) {
    if (match[1]) continue;   // struck-through (removed) text
    const text = visibleText(match[2]);
    if (text) found.push(text);
  }
  return summarizeTexts(found);
}

// A change is measured in letters and digits only (any script), so spaces,
// punctuation and decoration such as "[ENG]" brackets or " | " separators do not
// add to the size.
// A date or time counts as a single change (see isDateTimeBlock()).
function countTextCharacters(text) {
  if (isDateTimeBlock(text)) return 1;
  return (text.match(/[\p{L}\p{N}]/gu) || []).length;
}

function summarizeTexts(found) {
  const top = [...found]
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
    .map((text) => text.length > 70 ? `${text.slice(0, 67)}...` : text);
  return {
    count: found.length,
    characters: found.reduce((sum, text) => sum + countTextCharacters(text), 0),
    top,
  };
}

/**
 * @param {Page} page - Page object to diff.
 * @param {string} oldHtml - Previously stored rendered snapshot.
 * @param {string} newHtml - Most recently stored rendered snapshot.
 *
 * @returns {{html: string, summary: object}} The highlighted page and a
 * summary of what was highlighted (see summarizeHighlights()).
 */
// Script and style blocks are code, not page text. Analytics scripts and
// inlined CSS change on every load, so they must not be compared or marked.
// They are swapped for an identical placeholder before the diff and the
// new page's own blocks are put back afterwards, so the page still displays
// exactly as it was captured.
const CODE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const CODE_MASK = '<script data-updatescan-mask="1"></script>';
const CODE_MASK_PATTERN = /<script data-updatescan-mask="1"><\/script>/g;

function maskCode(html) {
  const blocks = [];
  const masked = html.replace(CODE_BLOCK, (block) => {
    blocks.push(block);
    return CODE_MASK;
  });
  return {masked, blocks};
}

function restoreCode(html, blocks) {
  let next = 0;
  return html.replace(CODE_MASK_PATTERN, () => blocks[next++] || '');
}

// Parts that are not page content that is showing: whatever the scan marked as
// hidden (other carousel slides, closed menus), plus the page head (title and
// metadata), <noscript> fallbacks and <template> blocks.
const NOT_SHOWN = '[data-updatescan-hidden="1"], head, noscript, template';

/**
 * Changes in parts that are not showing are not shown to the user, so they get
 * no highlight and are left out of the summary.
 *
 * @param {string} html - Diff output with scripts and styles restored.
 *
 * @returns {{html: string, summary: object}} The page without those highlights
 * and what is still highlighted.
 */
const NUMBER_ONLY = /^[\s\d.,'   ٬-]*$/;

// A number with a % or K/M/B suffix ("72%", "8.1K", "10K", "1.2M") is still just a
// number: ratings, view counts and the like. It needs at least one digit.
const NUMBER_WITH_UNIT =
  /^\s*[+\-−]?[\d.,'’   ٬]*\d[\d.,'’   ٬]*\s*(?:%|[kKmMbB])?\s*$/;

// A highlighted date or time is one change, however long it is written: it is a
// block ("October 12, 2026", "7 hours ago", "10:30 PM"), not that many separate
// edits. The diff may also highlight just the unit that changed ("hours" -> "days"),
// so a bare time unit counts as well.
const TIME_UNIT = '(?:second|minute|hour|day|week|month|year)s?';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const WEEKDAY = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+';
const CLOCK = '\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)?';
const DATE_TIME_BLOCK = new RegExp(
  '^\\s*(?:' +
  // relative: "7 hours ago", "Updated: 2 weeks ago", "just now", "yesterday"
  '(?:(?:updated|posted|added|published)\\s*:?\\s*)?(?:(?:\\d+|an?|one)\\s*' +
  `${TIME_UNIT}\\s+ago|just\\s+now|yesterday|today|\\d*\\s*${TIME_UNIT})|` +
  // "October 12, 2026", "Oct 12", "Mon, Oct 12th 2026", with an optional time
  `(?:${WEEKDAY})?${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{2,4})?` +
  `(?:,?\\s+(?:at\\s+)?${CLOCK})?|` +
  // "12 October 2026"
  `\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+\\d{2,4})?` +
  `(?:,?\\s+(?:at\\s+)?${CLOCK})?|` +
  // "2026-10-12", "10/12/2026", "12.10.26", with an optional time
  `\\d{1,4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,4}(?:[T\\s,]+${CLOCK})?|` +
  // a clock time on its own: "10:30 PM", "16:42"
  `${CLOCK}` +
  ')\\s*$', 'i');

function isDateTimeBlock(text) {
  return DATE_TIME_BLOCK.test(text);
}

// With "ignore numbers" on, a highlight that is only a number is not a change. That
// covers view, like and comment counts, whose label is not highlighted when only the
// digits change.
function isNumberOnly(text) {
  return NUMBER_ONLY.test(text) || NUMBER_WITH_UNIT.test(text);
}

function dropHiddenHighlights(html, ignoreNumbers = false) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const found = [];
  doc.querySelectorAll('span[style]').forEach((span) => {
    if (!seedIsHighlight(span)) return;
    if (span.closest(NOT_SHOWN)) {
      span.replaceWith(...span.childNodes);   // keep the text, drop the highlight
    } else if (!(span.getAttribute('style') || '').includes('line-through')) {
      const text = visibleText(span.innerHTML);
      // With "ignore numbers" on, a highlight that is only a number (like a
      // view count written "3 907" or "55,920") is not a change.
      if (ignoreNumbers && text && isNumberOnly(text)) {
        span.replaceWith(...span.childNodes);
      } else if (text) {
        found.push(text);
      }
    }
  });
  return {html: doc.documentElement.outerHTML, summary: summarizeTexts(found)};
}

function finishDiff(html, ignoreNumbers) {
  const visibleOnly = dropHiddenHighlights(html, ignoreNumbers);
  return {
    html: injectAdaptiveHighlighting(visibleOnly.html),
    summary: visibleOnly.summary,
  };
}

export function diffWithSummary(page, oldHtml, newHtml) {
  oldHtml = oldHtml || '';
  newHtml = newHtml || '';
  const before = maskCode(oldHtml);
  const after = maskCode(newHtml);
  const beforeIds = maskRandomIds(before.masked);
  const afterIds = maskRandomIds(after.masked);

  let diffHtml = highlightDiffs(
    beforeIds.masked, afterIds.masked, '#fff58a', '', '');

  // The placeholders in the result must be exactly the new page's own, in
  // order, to be swapped back for the real values. If they are not (which the
  // diff should never do), compare the pages as they are instead.
  const lined =
    countMatches(diffHtml, ID_PLACEHOLDER_PATTERN) === afterIds.originals.length &&
    countMatches(diffHtml, CODE_MASK_PATTERN) === after.blocks.length;
  if (!lined) {
    diffHtml = highlightDiffs(oldHtml, newHtml, '#fff58a', '', '');
    diffHtml = dropUnchangedHighlights(diffHtml, oldHtml, newHtml);
    return finishDiff(diffHtml, page && page.ignoreNumbers);
  }

  diffHtml = dropUnchangedHighlights(
    restoreRandomIds(diffHtml, afterIds.originals), oldHtml, newHtml);
  return finishDiff(restoreCode(diffHtml, after.blocks),
    page && page.ignoreNumbers);
}

export function diff(page, oldHtml, newHtml) {
  return diffWithSummary(page, oldHtml, newHtml).html;
}
