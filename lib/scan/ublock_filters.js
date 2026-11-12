/**
 * Turns the ignored parts of links into uBlock Origin cosmetic filters, so the
 * user can paste them into uBlock Origin's "My filters" and make the hiding
 * permanent. (uBlock Origin has no way for another add-on to add filters, so
 * the text is copied, not installed.)
 *
 * Only parts picked as **Exclude** are written; parts picked as **Ignore** stay
 * inside Update Scanner Reborn.
 *
 * One block of text: a start and an end marker (so a later paste can replace
 * the whole block), then one section per site with its name and the date.
 */

import {normaliseParts} from './excluded_parts.js';

// A selector with no class, id or attribute, only tags and positions.
const positionOnly = (selector) =>
  !/[.#[]/.test(selector.replace(/:nth-child\(\d+\)/g, ''));

export const FILTER_START = '! ==== Update Scanner Reborn: start ====';
export const FILTER_END = '! ==== Update Scanner Reborn: end ====';

/**
 * @param {string} url - Page address.
 *
 * @returns {string} The site name for a filter ('' when there is none).
 */
function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (error) {
    return '';
  }
}

/**
 * @param {Array<{url: string, title: string, parts: *}>} entries - Links.
 * @param {string} today - Date of the export, YYYY-MM-DD.
 *
 * @returns {{text: string, filters: number, sites: number, skipped: number,
 * notExcluded: number}}
 * The block to paste and how many filters and sites it holds, and how many
 * parts were left out because they are Ignore, not Exclude.
 */
export function buildUblockFilters(entries, today) {
  const sites = new Map();
  let skipped = 0;
  let notExcluded = 0;
  let weak = 0;
  for (const entry of entries) {
    const site = siteOf(entry.url);
    for (const part of normaliseParts(entry.parts)) {
      if (part.kind === 'layers' || part.kind === 'popups' || part.kind === 'script') continue;
      if (part.kind !== 'exclude' && part.kind !== 'noclick') {
        notExcluded++;
        continue;
      }
      // A filter is one line: anything else cannot be pasted safely.
      if (!site || /[\r\n]/.test(part.selector)) {
        skipped++;
        continue;
      }
      if (!sites.has(site)) sites.set(site, {titles: new Set(), parts: new Map()});
      const group = sites.get(site);
      if (entry.title) group.titles.add(entry.title);
      // Click-blocking parts are written as a style filter that uBlock Origin understands.
      const body = part.kind === 'noclick' ? `${part.selector}:style(pointer-events: none !important)` : part.selector;
      const previous = group.parts.get(body);
      const added = part.added || today;
      if (!previous || added < previous) group.parts.set(body, added);
      if (!previous && positionOnly(part.selector)) weak++;
    }
  }

  const lines = [FILTER_START,
    `! Created by Update Scanner Reborn, exported ${today}`];
  let filters = 0;
  for (const site of [...sites.keys()].sort()) {
    const group = sites.get(site);
    const dates = [...group.parts.values()].sort();
    const names = [...group.titles].join(', ');
    lines.push('', `! ${site}${names ? ` (${names})` : ''} - excluded parts` +
      ` saved ${dates[0]}`);
    for (const selector of group.parts.keys()) {
      lines.push(`${site}##${selector}`);
      filters++;
    }
  }
  if (skipped) {
    lines.push('', `! ${skipped} ignored part(s) could not be written as a filter and were left out`);
  }
  if (weak) {
    lines.push('', `! Warning: ${weak} rule(s) use only tags and positions (no class or id). ` +
      'They may not match the live site. Pick those parts again to get a sturdier rule.');
  }
  lines.push(FILTER_END);
  return {text: lines.join('\n') + '\n', filters, sites: sites.size, skipped, notExcluded, weak,
    siteNames: [...sites.keys()].sort(), linkCount: entries.length};
}
