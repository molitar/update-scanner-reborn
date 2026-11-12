/**
 * Parts of a page that a link ignores (a rotating news ticker, a visitor
 * counter, an advert slot).
 *
 * The user picks them in the page view (see lib/main/exclude_picker.js); each
 * one is stored on the page as {selector, label}: a CSS selector for the part
 * and a short name to show in the settings. The parts are removed from BOTH
 * snapshots before anything is compared, so nothing inside them can create a
 * change, a highlight, a count or a Next / Previous stop.
 */

// Storage key of the switch "Hide excluded parts on sites" (toolbar Menu).
export const HIDE_EXCLUDED_KEY = 'updatescan:hide-excluded-live';

// The sentinel selector of the site-wide part "make hidden click layers
// click-through" (kind 'layers'). It is not CSS and is never exported.
export const CLICK_LAYERS_SELECTOR = ':usr-click-layers';
export const BLOCK_POPUPS_SELECTOR = ':usr-block-popups';
export const BLOCK_SCRIPT_PREFIX = ':urs1-block-script:';
export const BLOCK_FRAMES_SELECTOR = ':urs1-block-third-party-frames';

// Block only explicit hostnames, never URL patterns or arbitrary regular expressions.
export function blockedScriptHost(part) {
  if (!part || part.kind !== 'script' || typeof part.selector !== 'string' ||
      !part.selector.startsWith(BLOCK_SCRIPT_PREFIX)) return '';
  const host = part.selector.slice(BLOCK_SCRIPT_PREFIX.length).toLowerCase();
  return host.length <= 253 && host.includes('.') &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) ? host : '';
}

/**
 * @param {*} list - Stored value (may be missing or malformed).
 *
 * @returns {Array<{selector: string, label: string}>} A clean list.
 */
export function normaliseParts(list) {
  if (!Array.isArray(list)) return [];
  const clean = [];
  const seen = new Set();
  for (const entry of list) {
    const selector = entry && typeof entry.selector === 'string' ?
      entry.selector.trim() : '';
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    const part = {
      selector,
      label: entry && typeof entry.label === 'string' ?
        entry.label.slice(0, 120) : selector,
    };
    // The day it was added (YYYY-MM-DD), used when exporting uBlock filters.
    if (entry && /^\d{4}-\d\d-\d\d$/.test(entry.added)) part.added = entry.added;
    // 'exclude' parts are also written out as uBlock Origin filters; anything
    // else is just ignored by the scans.
    if (entry && (entry.kind === 'include' || entry.kind === 'exclude' || entry.kind === 'layers' ||
        entry.kind === 'popups' || entry.kind === 'noclick' ||
        entry.kind === 'script' || entry.kind === 'frames')) part.kind = entry.kind;
    if (part.kind === 'script' && !blockedScriptHost(part)) continue;
    if (part.kind === 'frames' && selector !== BLOCK_FRAMES_SELECTOR) continue;
    if (part.kind === 'layers' && entry.hide === true) part.hide = true;
    clean.push(part);
  }
  return clean;
}

/**
 * @param {?string} html - A stored snapshot.
 * @param {*} parts - The page's ignored parts.
 *
 * @returns {?string} The snapshot without those parts (the same string when
 * there is nothing to remove).
 */
export function removeExcluded(html, parts) {
  // Parts that only block clicks stay in the page: the scans still see them.
  const list = normaliseParts(parts).filter((part) =>
    !['include', 'noclick', 'script', 'frames'].includes(part.kind));
  if (!html || !list.length) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Find every part first and only then remove them. Selectors that count
  // positions (li:nth-child(3)) would otherwise point at the wrong item once an
  // earlier part had been removed, and a part would stay behind.
  const found = new Set();
  for (const {selector} of list) {
    try {
      doc.querySelectorAll(selector).forEach((element) => found.add(element));
    } catch (error) {
      // A selector that is not valid CSS is skipped.
    }
  }
  let removed = 0;
  for (const element of found) {
    element.remove();
    removed++;
  }
  return removed ? doc.documentElement.outerHTML : html;
}


// Only explicit Exclude rules disappear from the saved view. Legacy Ignore
// rules still suppress comparison, but stay visible in the snapshot.
export function removeForView(html, parts) {
  return removeExcluded(html, normaliseParts(parts).filter(p =>
    p.kind === 'exclude'));
}

// A positive scope: no Include rule means the normal comparison applies.
export function hasInclude(parts) {
  return normaliseParts(parts).some(p => p.kind === 'include');
}

export function hasNonCountingRegions(parts) {
  return normaliseParts(parts).some(p => p.kind === 'include' || !p.kind || p.kind === 'ignore');
}

export const MASK_MARKER = '__URS_UNTRACKED_REGION__';

// Construct a comparison snapshot which has the same structure around the
// selected regions but a constant marker in every untracked subtree. Keep
// the new-page pieces for reconstructing its full, unhighlighted surroundings.
// The real source snapshots are never modified or saved in masked form.
export function scopedSnapshot(html, parts) {
  const normalized = normaliseParts(parts);
  const includes = normalized.filter(p => p.kind === 'include');
  const ignored = normalized.filter(p => !p.kind || p.kind === 'ignore');
  const excludes = normalized.filter(p => p.kind === 'exclude');
  if (!includes.length && !ignored.length && !excludes.length)
    return {html: html || '', chunks: [], masked: false};
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const select = list => {
    const set = new Set();
    for (const part of list) {
      try { doc.querySelectorAll(part.selector).forEach(e => set.add(e)); }
      catch (_) { /* Stored invalid selectors do not affect the page. */ }
    }
    return set;
  };
  // Exclude wins over Ignore and Include.
  const excluded = select(excludes);
  for (const element of excluded) element.remove();
  const ignoredNodes = select(ignored);
  const includeNodes = select(includes);
  const chunks = [];
  const mask = nodes => {
    if (!nodes.length) return;
    const first = nodes[0];
    chunks.push(nodes.map(n => n.outerHTML ?? (n.textContent || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')).join(''));
    first.replaceWith(doc.createTextNode(MASK_MARKER));
    for (const other of nodes.slice(1)) other.remove();
  };
  const isIgnored = e => e.nodeType === 1 && ignoredNodes.has(e);
  const hasIncludeInside = e => e.nodeType === 1 &&
    [...includeNodes].some(n => e.contains(n));
  const process = (parent, inside) => {
    let pending = [];
    const flush = () => {mask(pending); pending = [];};
    for (const child of [...parent.childNodes]) {
      if (!child.isConnected) continue;
      if (isIgnored(child)) { pending.push(child); continue; }
      const selected = child.nodeType === 1 && includeNodes.has(child);
      const containsSelected = !inside && hasIncludeInside(child);
      if (includes.length && !inside && !selected && !containsSelected) {
        pending.push(child);
        continue;
      }
      flush();
      if (child.nodeType === 1) process(child, inside || selected);
    }
    flush();
  };
  if (includes.length) {
    // Head changes do not count when an Include exists. The full head is
    // restored from the new captured snapshot after the diff is finished.
    doc.head.replaceChildren();
  }
  process(doc.body, !includes.length);
  return {html: doc.documentElement.outerHTML, chunks, masked: true};
}

// Return a complete displayed page. A diff touching a marker cannot safely
// be mapped back, so the caller can suppress that diff rather than invent
// highlights for content which is outside the Include region.
export function restoreScopedDiff(diffHtml, snapshot, displayHtml) {
  if (!snapshot.masked) return {html: diffHtml, ok: true};
  const doc = new DOMParser().parseFromString(diffHtml || '', 'text/html');
  const displayed = new DOMParser().parseFromString(displayHtml || '', 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes(MASK_MARKER)) nodes.push(walker.currentNode);
  }
  // If the diff realigned/duplicated/moved a placeholder, fail closed:
  // no spurious highlight or missing page content.
  const occurrences = nodes.reduce((n, t) => n + t.nodeValue.split(MASK_MARKER).length - 1, 0);
  if (occurrences !== snapshot.chunks.length) return {html: displayHtml, ok: false};
  let cursor = 0;
  for (const node of nodes) {
    const pieces = node.nodeValue.split(MASK_MARKER);
    const replacements = [];
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i]) replacements.push(doc.createTextNode(pieces[i]));
      if (i < pieces.length - 1) {
        const template = doc.createElement('template');
        template.innerHTML = snapshot.chunks[cursor++];
        replacements.push(...template.content.childNodes);
      }
    }
    // No highlight may include an untracked replacement.
    const container = node.parentElement;
    if (container && /background(?:-color)?\s*:\s*(?:#fff58a|rgb\(255,\s*245,\s*138\))/i
      .test(container.getAttribute('style') || '') && container.textContent.includes(MASK_MARKER)) {
      container.replaceWith(...replacements);
    } else node.replaceWith(...replacements);
  }
  // Keep adaptive highlight styling/scripts from the diff result.
  for (const el of [...doc.head.querySelectorAll('[data-updatescan-adaptive-highlight-style], [data-updatescan-adaptive-highlight-script]')]) {
    displayed.head.appendChild(el.cloneNode(true));
  }
  doc.head.replaceWith(displayed.head);
  return {html: doc.documentElement.outerHTML, ok: true};
}
