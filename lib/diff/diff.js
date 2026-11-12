import {highlightDiffs} from './diff_engine.js';
import {removeExcluded, removeForView, hasNonCountingRegions, scopedSnapshot, restoreScopedDiff, MASK_MARKER} from '/lib/scan/excluded_parts.js';

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

// With "Ignore changes to numbers" the comparison itself must not see numbers.
// Otherwise the word diff lines up the words around a changed number ("Guests,
// 3 Users (7" against "Guests, 2 Users (5") and highlights those words. Numbers
// in text (not in tags or attributes) are swapped for one placeholder in both
// pages before the diff, and the new page's own numbers are put back after it.
const NUM_PLACEHOLDER = '__updatescan_num__';
const NUM_PLACEHOLDER_PATTERN = /__updatescan_num__/g;
const TEXT_BETWEEN_TAGS = />([^<]+)</g;
const NUMBER_IN_TEXT = /&#[0-9]+;|&#x[0-9a-f]+;|\d+(?:[.,:'’\u00a0\u202f\u2009 ]+\d+)*(?:\s*[kKmMbB](?![A-Za-z]))?%?/gi;

/**
 * @param {string} html - HTML.
 *
 * @returns {{masked: string, originals: string[]}} The HTML with every number
 * in its text replaced by the placeholder, and those numbers in order.
 */
export function maskNumbers(html) {
  const originals = [];
  const masked = html.replace(TEXT_BETWEEN_TAGS, (match, text) => '>' +
    text.replace(NUMBER_IN_TEXT, (number) => {
      if (number.startsWith('&')) return number;   // an HTML entity such as &#39;
      originals.push(number);
      return NUM_PLACEHOLDER;
    }) + '<');
  return {masked, originals};
}

// With "Ignore changes to dates and times" the same trick is used for dates and
// times: "08:46:42 PM", "Today at 7:46 PM", "October 29, 2026", "2026-10-29",
// "12 October 2026", "7 hours ago". They are swapped for one placeholder before
// the diff, and the new page's own text is put back after it.
const DATE_PLACEHOLDER = '__updatescan_date__';
const DATE_PLACEHOLDER_PATTERN = /__updatescan_date__/g;
const D_UNIT = '(?:second|minute|hour|day|week|month|year)s?';
// The text is matched as it is written in the page's HTML, where a theme often
// writes "November&nbsp;6,&nbsp;2026": those entities count as spaces.
const SP = '(?:\\s|&nbsp;|&#160;|&#[xX][aA]0;)';
const D_MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const D_WEEKDAY = `(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?${SP}+)?`;
const D_CLOCK = `\\d{1,2}:\\d{2}(?::\\d{2})?(?:${SP}*[ap]\\.?m\\.?)?`;
const DATE_IN_TEXT = new RegExp(
  '(?<![\\w/])(?:' +
  // "Today at 07:46:12 PM", "yesterday 9:15"
  `(?:today|yesterday|tomorrow)(?:${SP}+at)?(?:${SP}+${D_CLOCK})?|` +
  // "Updated: 2 weeks ago", "7 hours ago", "just now"
  `(?:(?:updated|posted|added|published)${SP}*:?${SP}*)?(?:(?:\\d+|an?|one)${SP}*${D_UNIT}${SP}+ago)|just${SP}+now|` +
  // "October 29, 2026", "Mon, Oct 12th 2026 at 7:05 PM"
  `${D_WEEKDAY}${D_MONTH}${SP}+\\d{1,2}(?:st|nd|rd|th)?(?:,?${SP}+\\d{2,4})?(?:,?${SP}+(?:at${SP}+)?${D_CLOCK})?|` +
  // "12 October 2026"
  `\\d{1,2}(?:st|nd|rd|th)?${SP}+${D_MONTH}(?:,?${SP}+\\d{2,4})?(?:,?${SP}+(?:at${SP}+)?${D_CLOCK})?|` +
  // "2026-10-29", "10/12/2026", "12.10.26", with an optional time
  `\\d{1,4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,4}(?:(?:T|,|${SP})+${D_CLOCK})?|` +
  // "08:46:42 PM", "16:42"
  `${D_CLOCK}` +
  ')(?![\\w])', 'gi');

/**
 * @param {string} html - HTML.
 *
 * @returns {{masked: string, originals: string[]}} The HTML with every date or
 * time in its text replaced by the placeholder, and those texts in order.
 */
export function maskDates(html) {
  const originals = [];
  const masked = html.replace(TEXT_BETWEEN_TAGS, (match, text) => '>' +
    text.replace(DATE_IN_TEXT, (found) => {
      originals.push(found);
      return DATE_PLACEHOLDER;
    }) + '<');
  return {masked, originals};
}

function restoreDates(html, originals) {
  let next = 0;
  return html.replace(DATE_PLACEHOLDER_PATTERN, () => originals[next++] || '');
}

function restoreNumbers(html, originals) {
  let next = 0;
  return html.replace(NUM_PLACEHOLDER_PATTERN, () => originals[next++] || '');
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
// A clock time on its own ("08:46:42", "7:05 PM", "16:42") is a number too: a
// running clock in a page header must not count as a change.
const CLOCK_ONLY = /^\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\s*$/i;

// With "Ignore changes to dates and times" a highlight that is nothing but a
// date or time is not a change, even inside a block of text that is new (a new
// card brings its own date).
function isDateOnly(text) {
  const stripped = text.replace(DATE_IN_TEXT, '');
  // Something was a date, and nothing but separators is left.
  return stripped !== text && stripped.replace(/[\s,.:;|()\-]+/g, '') === '';
}

function isNumberOnly(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (CLOCK_ONLY.test(value)) return true;
  if (/^[kKmMbB]$/.test(value)) return true;

  // Handle multiple numeric tokens in one highlighted element:
  // "100% (34)", "98% (54)", "21.3K (1,200)".
  const numericTokens =
    /\d+(?:[.,:'’\u00a0\u202f\u2009 ]+\d+)*(?:\s*[kKmMbB](?![A-Za-z]))?%?/gi;
  const withoutNumbers = value.replace(numericTokens, '');
  const withoutSeparators =
    withoutNumbers.replace(/[\s()[\]{},.;:%+\-−'’\u00a0\u202f\u2009]/g, '');

  return /\d/.test(value) && withoutSeparators === '';
}

// ---- Counting changed blocks (page setting "Count each changed block as one
// change"). A listing page shows its posts / items as repeated blocks. When a
// whole post is new, its title, date, category and so on are highlighted
// separately; counted by characters that is hundreds, but the user sees ONE new
// post. A block is the outermost repeated element (an element with a similar
// sibling: same tag and a shared class, or no classes at all) that is still
// post-sized; text with no repeated element around it counts as one block per
// nearest block-level element.
const INLINE_TAGS = new Set(['A', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'SUP',
  'SUB', 'FONT', 'U', 'ABBR', 'LABEL', 'TIME', 'MARK', 'CODE', 'BR', 'IMG', 'S',
  'DEL', 'INS', 'CITE', 'Q', 'BDI', 'BDO']);

// A repeated block holds more text than this only if it is a container of
// many items, not one item.
const MAX_BLOCK_TEXT = 1500;

// ...except an item of a real list (three or more alike siblings: the posts of a
// feed, the cards of a grid), which may be much longer: a post whose full text
// sits behind a "Show more" is thousands of characters.
const MAX_LIST_ITEM_TEXT = 20000;
const MIN_LIST_SIBLINGS = 3;

// Every changed block counts as this many characters when blocks are counted,
// so the existing threshold steps still apply: 10 ignores one changed block,
// 30 three, and so on.
export const BLOCK_WEIGHT = 10;

function sameKind(a, b) {
  if (a.tagName !== b.tagName) return false;
  const classesA = [...a.classList];
  const classesB = [...b.classList];
  if (classesA.length === 0 && classesB.length === 0) return true;
  return classesA.some((name) => classesB.includes(name));
}

function isRepeated(element) {
  return alikeSiblings(element) > 0;
}

// How many other elements next to this one are of the same kind.
function alikeSiblings(element) {
  const parent = element.parentElement;
  if (!parent) return 0;
  let count = 0;
  for (const sibling of parent.children) {
    if (sibling !== element && sameKind(sibling, element)) count++;
  }
  return count;
}

/**
 * @param {Element} node - A highlighted element.
 *
 * @returns {Element} The block (post, list item, table row) it belongs to.
 */
export function blockOf(node) {
  let nearest = null;
  let best = null;
  for (let element = node.parentElement;
    element && element.tagName !== 'BODY' && element.tagName !== 'HTML';
    element = element.parentElement) {
    if (INLINE_TAGS.has(element.tagName)) continue;
    if (!nearest) nearest = element;
    const alike = alikeSiblings(element);
    if (alike > 0) {
      const length = (element.textContent || '').length;
      const allowed = alike + 1 >= MIN_LIST_SIBLINGS ?
        MAX_LIST_ITEM_TEXT : MAX_BLOCK_TEXT;
      if (length > allowed) break;
      best = element;
    }
  }
  return best || nearest || node.parentElement || node;
}

// What a block says, for comparing it with the old page: its visible text with
// whitespace collapsed (and digits removed when numbers are ignored).
function blockSignature(element, ignoreNumbers, ignoreDates) {
  return normaliseText(element.textContent || '', ignoreNumbers, ignoreDates);
}

// Text as it is compared: whitespace collapsed; dates and times removed when
// they are ignored (before numbers, so "Oct 29, 2026" goes as one piece);
// digits removed when numbers are ignored.
function normaliseText(text, ignoreNumbers, ignoreDates) {
  let out = text;
  if (ignoreDates) out = out.replace(DATE_IN_TEXT, ' ');
  if (ignoreNumbers) out = out.replace(NUMBER_IN_TEXT, (value) => value.startsWith('&') ? value : '');
  return out.replace(/\s+/g, ' ').trim();
}

// A block that is this much the same as a block of the old page (share of its
// words that also appear in the old one) is the same block: a new comment count
// or a word edited in a long post is not a real change.
export const BLOCK_MATCH = 0.6;

// A changed block that is at least this alike to an old block is an EDITED
// block (the parts that differ are highlighted); below it, the block is new
// (its main text is highlighted).
const EDITED_BLOCK = 0.4;

function wordCounts(text) {
  const counts = new Map();
  for (const word of text.split(' ')) {
    if (word) counts.set(word, (counts.get(word) || 0) + 1);
  }
  return counts;
}

// How alike two word lists are, 0 to 1 (Dice coefficient on word counts).
function similarity(a, b) {
  let total = 0;
  let common = 0;
  for (const n of a.values()) total += n;
  for (const n of b.values()) total += n;
  if (total === 0) return 1;
  for (const [word, n] of a) {
    if (b.has(word)) common += Math.min(n, b.get(word));
  }
  return (2 * common) / total;
}

// Looks up whether a block of the new page is also on the old page, exactly or
// at least BLOCK_MATCH alike. Built once per comparison.
function oldBlockFinder(oldHtml, ignoreNumbers, match = BLOCK_MATCH, ignoreDates = false) {
  const byTag = new Map();
  const oldDoc = new DOMParser().parseFromString(
    oldHtml.replace(CODE_BLOCK, ' '), 'text/html');
  const entries = (tagName) => {
    let list = byTag.get(tagName);
    if (!list) {
      list = {exact: new Set(), items: []};
      oldDoc.querySelectorAll(tagName).forEach((element) => {
        const text = blockSignature(element, ignoreNumbers, ignoreDates);
        list.exact.add(text);
        if (text.length > 0 && text.length <= MAX_BLOCK_TEXT * 2) {
          list.items.push({text, length: text.length, words: null, element});
        }
      });
      byTag.set(tagName, list);
    }
    return list;
  };
  // Returns {same, best, score}: whether the block is on the old page (exactly
  // or at least `match` alike), the old block that is most like it (null when
  // none is even remotely alike, which means the block is new), and how alike
  // that best one is (0 to 1; 1 for an identical block). The score is what lets
  // the Changes view say how many blocks there would be at any setting.
  return (block) => {
    const text = blockSignature(block, ignoreNumbers, ignoreDates);
    const list = entries(block.tagName);
    if (list.exact.has(text)) return {same: true, best: null, score: 1};
    if (text.length === 0) return {same: false, best: null, score: 0};
    const words = wordCounts(text);
    let best = null;
    let bestScore = 0;
    for (const item of list.items) {
      if (item.length < text.length * 0.4 || item.length > text.length * 2.5) continue;
      if (!item.words) item.words = wordCounts(item.text);
      const score = similarity(words, item.words);
      if (score > bestScore) {
        bestScore = score;
        best = item.element;
      }
    }
    const same = bestScore >= match;
    return {
      same,
      best: !same && bestScore >= EDITED_BLOCK ? best : null,
      score: bestScore,
    };
  };
}

// The main text of a block: its heading, else its first link with text.
function primaryTextOf(block) {
  if (/^H[1-6]$/.test(block.tagName)) return block;
  const heading = block.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading && (heading.textContent || '').trim()) return heading;
  for (const link of block.querySelectorAll('a[href]')) {
    if ((link.textContent || '').trim().length >= 3) return link;
  }
  return null;
}

// The text pieces of a block, each one the text directly inside one element
// (a title, a line under the picture, a date), normalised for comparison.
function textPieces(root) {
  const pieces = [];
  const walker = [root, ...root.querySelectorAll('*')];
  for (const element of walker) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(element.tagName)) continue;
    for (const node of element.childNodes) {
      if (node.nodeType !== 3) continue;
      const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (text) pieces.push({node, text});
    }
  }
  return pieces;
}

/**
 * @param {Element} block - A block of the new page.
 * @param {Element} old - The most alike block of the old page.
 *
 * @returns {Text[]} The text nodes of the block that are not in the old block,
 * so only the changed text is highlighted.
 */
function differingTexts(block, old, ignoreNumbers, ignoreDates) {
  const oldTexts = new Set(textPieces(old).map((piece) =>
    normaliseText(piece.text, ignoreNumbers, ignoreDates)));
  const out = [];
  for (const {node, text} of textPieces(block)) {
    const compared = normaliseText(text, ignoreNumbers, ignoreDates);
    // A piece that is only a date, time or number (when those are ignored) is
    // not a change; neither is one that is also in the old block.
    if (compared === '' && (ignoreNumbers || ignoreDates)) continue;
    if (oldTexts.has(compared)) continue;
    if (ignoreNumbers && isNumberOnly(text)) continue;
    out.push(node);
  }
  return out;
}

function dropHiddenHighlights(html, ignoreNumbers = false, countBlocks = false,
  oldHtml = '', blockMatch = BLOCK_MATCH, ignoreDates = false) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const found = [];
  const blocks = new Set();
  const spansByBlock = new Map();
  const verdicts = new Map();
  const blockScores = [];
  let inOldPage = null;
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
      } else if (ignoreDates && text && isDateOnly(text)) {
        span.replaceWith(...span.childNodes);
      } else if (text) {
        found.push(text);
        const block = blockOf(span);
        blocks.add(block);
        if (!spansByBlock.has(block)) spansByBlock.set(block, []);
        spansByBlock.get(block).push({span, text});
      }
    }
  });
  if (countBlocks && oldHtml) {
    // A block whose whole text is also on the old page did not change, it only
    // moved (a new post pushes the others down and the word diff then marks
    // scraps of them). Drop its highlights; what is left are the new or
    // edited blocks.
    inOldPage = oldBlockFinder(oldHtml, ignoreNumbers, blockMatch, ignoreDates);
    for (const [block, items] of spansByBlock) {
      const verdict = inOldPage(block);
      verdicts.set(block, verdict);
      blockScores.push(verdict.score);
      if (!verdict.same) continue;
      blocks.delete(block);
      for (const {span, text} of items) {
        span.replaceWith(...span.childNodes);
        const at = found.indexOf(text);
        if (at !== -1) found.splice(at, 1);
      }
    }
  }
  if (countBlocks) {
    // Show one highlight per changed block, on its main text (the title), so
    // the rest of the block, such as its picture, stays clearly visible. A
    // block with no usable main text keeps the highlights the diff made.
    found.length = 0;
    let blockId = 0;
    for (const block of blocks) {
      blockId++;
      // The block itself, so the viewer can draw a box around it even when its
      // highlight cannot be seen (a new thumbnail whose title is hidden).
      block.setAttribute('data-updatescan-block-box', String(blockId));
      const items = spansByBlock.get(block) || [];
      const mark = () => {
        const span = doc.createElement('span');
        span.setAttribute('style', 'background-color: #fff58a;');
        span.setAttribute('data-updatescan-block', String(blockId));
        return span;
      };
      // The diff cut the block's text into pieces with its own marks. Take
      // them off: the block is compared with the old block as plain text and
      // gets exactly one set of highlights.
      for (const {span} of items) span.replaceWith(...span.childNodes);
      block.normalize();

      // An edited block: highlight exactly the parts that differ from the old
      // block, so the user sees what changed.
      const verdict = verdicts.get(block) || (inOldPage ? inOldPage(block) : null);
      const old = verdict ? verdict.best : null;
      const differing = old ?
        differingTexts(block, old, ignoreNumbers, ignoreDates) : [];
      if (differing.length) {
        for (const textNode of differing) {
          const wrapper = mark();
          textNode.replaceWith(wrapper);
          wrapper.append(textNode);
          found.push(visibleText(wrapper.innerHTML));
        }
        continue;
      }
      // A new block (or nothing to point at): highlight its main text.
      const target = primaryTextOf(block);
      if (target) {
        const wrapper = mark();
        wrapper.append(...target.childNodes);
        target.append(wrapper);
        found.push(visibleText(wrapper.innerHTML));
      } else {
        const first = textPieces(block)[0];
        if (first) {
          const wrapper = mark();
          first.node.replaceWith(wrapper);
          wrapper.append(first.node);
          found.push(first.text);
        }
      }
    }
  }
  const summary = summarizeTexts(found);
  summary.blocks = blocks.size;
  if (countBlocks) {
    // A block with nothing highlighted (no heading or link, no differing text)
    // is not a stop for Next / Previous: do not count it either, so the block
    // count and the number of stops stay the same.
    let marked = 0;
    for (const block of blocks) {
      if (block.querySelector(`[style*="fff58a" i], [data-updatescan-block]`)) {
        marked++;
      } else {
        block.removeAttribute('data-updatescan-block-box');
      }
    }
    summary.blocks = marked;
  }
  if (countBlocks && oldHtml) {
    // How many blocks there would be at each "alike" setting: a block counts
    // while nothing on the old page is at least that alike to it.
    summary.blockCounts = {};
    for (const percent of [100, 90, 80, 70, 60, 50, 40, 30, 20, 10]) {
      summary.blockCounts[percent] =
        blockScores.filter((score) => score < percent / 100).length;
    }
  }
  summary.rawCharacters = summary.characters;
  if (countBlocks) {
    // Each changed block counts the same however much of it changed.
    summary.characters = blocks.size * BLOCK_WEIGHT;
  }
  return {html: doc.documentElement.outerHTML, summary};
}

function finishDiff(html, ignoreNumbers, countBlocks, oldHtml, blockMatch,
  ignoreDates) {
  const visibleOnly = dropHiddenHighlights(
    html, ignoreNumbers, countBlocks, oldHtml, blockMatch, ignoreDates);
  return {
    html: injectAdaptiveHighlighting(visibleOnly.html),
    summary: visibleOnly.summary,
  };
}

export function diffWithSummary(page, oldHtml, newHtml) {
  oldHtml = oldHtml || '';
  newHtml = newHtml || '';
  // Include scopes compare only selected regions, but return the complete
  // new snapshot with excluded elements removed and other content visible.
  if (page && hasNonCountingRegions(page.excludedParts)) {
    const oldScoped = scopedSnapshot(oldHtml, page.excludedParts);
    const newScoped = scopedSnapshot(newHtml, page.excludedParts);
    const displayed = removeForView(newHtml, page.excludedParts);
    const scopedPage = {...page, excludedParts: []};
    const result = diffWithSummary(scopedPage, oldScoped.html, newScoped.html);
    const restored = restoreScopedDiff(result.html, newScoped, displayed);
    return restored.ok ? {...result, html: restored.html} :
      {html: displayed, summary: {characters: 0, rawCharacters: 0, blocks: 0, blockCounts: {}}};
  }
  // Parts this link ignores are removed from both pages first.
  if (page && page.excludedParts && page.excludedParts.length) {
    oldHtml = removeExcluded(oldHtml, page.excludedParts);
    newHtml = removeExcluded(newHtml, page.excludedParts);
  }
  const before = maskCode(oldHtml);
  const after = maskCode(newHtml);
  const beforeIds = maskRandomIds(before.masked);
  const afterIds = maskRandomIds(after.masked);

  let beforeText = beforeIds.masked;
  let afterText = afterIds.masked;
  let afterNumbers = null;
  let afterDates = null;
  if (page && page.ignoreDates) {
    // Dates first, so "Oct 29, 2026" is one masked piece, not number + words.
    const beforeDates = maskDates(beforeText);
    const afterMasked = maskDates(afterText);
    beforeText = beforeDates.masked;
    afterText = afterMasked.masked;
    afterDates = afterMasked.originals;
  }
  if (page && page.ignoreNumbers) {
    const beforeNums = maskNumbers(beforeText);
    const afterNums = maskNumbers(afterText);
    beforeText = beforeNums.masked;
    afterText = afterNums.masked;
    afterNumbers = afterNums.originals;
  }
  let diffHtml = highlightDiffs(
    beforeText, afterText, '#fff58a', '', '');

  // The placeholders in the result must be exactly the new page's own, in
  // order, to be swapped back for the real values. If they are not (which the
  // diff should never do), compare the pages as they are instead.
  const lined =
    countMatches(diffHtml, ID_PLACEHOLDER_PATTERN) === afterIds.originals.length &&
    countMatches(diffHtml, CODE_MASK_PATTERN) === after.blocks.length &&
    (!afterNumbers ||
      countMatches(diffHtml, NUM_PLACEHOLDER_PATTERN) === afterNumbers.length) &&
    (!afterDates ||
      countMatches(diffHtml, DATE_PLACEHOLDER_PATTERN) === afterDates.length);
  if (!lined) {
    diffHtml = highlightDiffs(oldHtml, newHtml, '#fff58a', '', '');
    diffHtml = dropUnchangedHighlights(diffHtml, oldHtml, newHtml);
    return finishDiff(diffHtml, page && page.ignoreNumbers,
      page && page.countBlocks === true, oldHtml, page && page.blockMatch,
      page && page.ignoreDates === true);
  }

  if (afterNumbers) diffHtml = restoreNumbers(diffHtml, afterNumbers);
  if (afterDates) diffHtml = restoreDates(diffHtml, afterDates);
  diffHtml = dropUnchangedHighlights(
    restoreRandomIds(diffHtml, afterIds.originals), oldHtml, newHtml);
  return finishDiff(restoreCode(diffHtml, after.blocks),
    page && page.ignoreNumbers, page && page.countBlocks === true, oldHtml,
    page && page.blockMatch, page && page.ignoreDates === true);
}

/**
 * The tuning preview "All changed": every block of the new page is shown as
 * changed, so the person can see how the page is divided into blocks. Parts the
 * link ignores, excludes or leaves out of an Include scope must still be left
 * alone, so the old side is the new page with its text emptied but its ignored
 * parts untouched: they are then identical on both sides and never highlighted.
 *
 * @param {object} page - The page (its excludedParts and settings).
 * @param {string} newHtml - The new snapshot.
 *
 * @returns {{html: string, summary: object}} As diffWithSummary().
 */
export function diffAllChanged(page, newHtml) {
  newHtml = newHtml || '';
  if (!(page && hasNonCountingRegions(page.excludedParts))) {
    return diffWithSummary(page, '<html><body></body></html>', newHtml);
  }
  const newScoped = scopedSnapshot(newHtml, page.excludedParts);
  const displayed = removeForView(newHtml, page.excludedParts);
  const blank = new DOMParser().parseFromString(newScoped.html, 'text/html');
  const walker = blank.createTreeWalker(blank.body, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const node of texts) {
    const tag = node.parentElement ? node.parentElement.tagName : '';
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(tag)) continue;
    const markers = node.nodeValue.split(MASK_MARKER).length - 1;
    node.nodeValue = MASK_MARKER.repeat(markers);
  }
  const scopedPage = {...page, excludedParts: []};
  const result = diffWithSummary(scopedPage, blank.documentElement.outerHTML,
    newScoped.html);
  const restored = restoreScopedDiff(result.html, newScoped, displayed);
  return restored.ok ? {...result, html: restored.html} :
    {html: displayed, summary: {characters: 0, rawCharacters: 0, blocks: 0, blockCounts: {}}};
}

export function diff(page, oldHtml, newHtml) {
  return diffWithSummary(page, oldHtml, newHtml).html;
}
