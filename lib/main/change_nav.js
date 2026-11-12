/**
 * Next / Previous change buttons for the Changes view.
 *
 * On a long page the highlighted changes can be far apart. The Changes view
 * shows the page in a sandboxed iframe and marks every highlighted piece of
 * text with data-updatescan-diff-highlight="1"; this module finds them and
 * scrolls the iframe from one change to the next.
 *
 * Highlights that are close together (the words of one edited sentence, a
 * changed table row) are one change: a new change starts when the next
 * highlight is more than GROUP_GAP pixels below the previous one.
 */

const GROUP_GAP = 60;
// Stops whose tops are this close belong to the same row of a grid.
const ROW_TOLERANCE = 40;

/**
 * Put the stops in reading order: rows from the top, and within a row from the
 * left. A row is every stop within ROW_TOLERANCE pixels of the row's first
 * (highest) one, so cards in a grid are walked left to right and then on to
 * the next row, however much their titles wrap.
 *
 * @param {Array<{top: number, left: number}>} stops - Stops to order.
 *
 * @returns {Array} The same stops, in reading order.
 */
export function orderStops(stops) {
  const byTop = [...stops].sort((x, y) => x.top - y.top || x.left - y.left);
  const rows = [];
  for (const stop of byTop) {
    const row = rows[rows.length - 1];
    if (row && stop.top - row.top <= ROW_TOLERANCE) {
      row.stops.push(stop);
    } else {
      rows.push({top: stop.top, stops: [stop]});
    }
  }
  const ordered = [];
  for (const row of rows) {
    row.stops.sort((x, y) => x.left - y.left || x.top - y.top);
    ordered.push(...row.stops);
  }
  return ordered;
}
const MARK = '[data-updatescan-diff-highlight="1"], [data-updatescan-box="1"]';

let doc = null;
let win = null;
let groups = null;
let groupsHeight = 0;
let current = -1;
let lastJumpTime = 0;     // when Next / Previous last scrolled
let lastJumpY = null;     // where that scroll was going (the page may stop short)
let pulseTimer = null;
let keyHandler = null;
let wired = false;

const qs = selector => document.querySelector(selector);

/**
 * Is this element inside something that stays on the screen while the page
 * scrolls (a sticky sidebar, a fixed bar)? Its position changes with every
 * scroll and scrolling to it means nothing, so it is not a stop.
 *
 * @param {Element} element - Element to test.
 * @param {Map<Element, boolean>} memo - Answers already found.
 *
 * @returns {boolean} True if it is pinned.
 */
function isPinned(element, memo) {
  if (!element || element.nodeType !== 1) return false;
  if (memo.has(element)) return memo.get(element);
  const position = win.getComputedStyle(element).position;
  const pinned = position === 'fixed' || position === 'sticky' ||
    isPinned(element.parentElement, memo);
  memo.set(element, pinned);
  return pinned;
}

/**
 * Find the changes in the viewed page, top to bottom.
 *
 * Highlights in sticky or fixed parts of the page are left out: they travel
 * with the scroll, so they have no place to jump to.
 *
 * @returns {Array<{top: number, bottom: number, elements: Element[]}>}
 */
export function findChanges() {
  if (!doc || !win) return [];
  const memo = new Map();
  const visible = [];
  const pinned = [];
  for (const element of doc.querySelectorAll(MARK)) {
    if (!element.getClientRects().length) continue; // hidden: nothing to see
    (isPinned(element, memo) ? pinned : visible).push(element);
  }
  // Highlights in sticky or fixed parts have no place to jump to, so they are
  // left out, unless that is ALL there is: then they are the stops (the page
  // does not scroll to them, but each is outlined), so the buttons still work.
  return groupChanges(visible.length ? visible : pinned);
}

export function groupChanges(elements) {
  const found = [];
  const byBlock = new Map();
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const top = rect.top + win.scrollY;
    const bottom = top + rect.height;
    const left = rect.left + win.scrollX;
    const block = element.getAttribute('data-updatescan-block');
    if (block) {
      // With block counting every highlight of one block is ONE stop, wherever
      // the highlights are in the page and whatever lies between them.
      const group = byBlock.get(block);
      if (group) {
        if (top < group.top || (top === group.top && left < group.left)) {
          group.left = left;
        }
        group.top = Math.min(group.top, top);
        group.bottom = Math.max(group.bottom, bottom);
        group.elements.push(element);
      } else {
        const created = {top, bottom, left, elements: [element], block};
        byBlock.set(block, created);
        found.push(created);
      }
      continue;
    }
    // Plain highlights: close together (words of one edited sentence) is one.
    const last = found[found.length - 1];
    if (last && !last.block && top - last.bottom <= GROUP_GAP) {
      last.bottom = Math.max(last.bottom, bottom);
      last.elements.push(element);
    } else {
      found.push({top, bottom, left, elements: [element], block: null});
    }
  }
  // The order Next / Previous walks them in: reading order (see orderStops).
  return orderStops(found);
}

/**
 * The changes, found once and kept so the count does not change while you
 * move around. Their positions are measured again each time; the list is only
 * rebuilt when the page itself changed size (pictures loaded, text revealed).
 *
 * @returns {Array<{top: number, bottom: number, elements: Element[]}>}
 */
function currentChanges() {
  if (!doc || !win) return [];
  const height = doc.documentElement.scrollHeight;
  if (!groups || Math.abs(height - groupsHeight) > 30) {
    groups = findChanges();
    groupsHeight = height;
    return groups;
  }
  for (const group of groups) {
    // Across ALL the group's highlights: the first one in the page's order is
    // not always the highest (a block's highlights can be spread out), and a
    // wrong top makes Next / Previous jump around.
    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    for (const element of group.elements) {
      const rect = element.getBoundingClientRect();
      if (rect.top + win.scrollY < top) {
        top = rect.top + win.scrollY;
        left = rect.left + win.scrollX;
      }
      bottom = Math.max(bottom, rect.bottom + win.scrollY);
    }
    group.top = top;
    group.bottom = bottom;
    group.left = left;
  }
  // The order may have changed with the layout: keep it in reading order.
  groups = orderStops(groups);
  return groups;
}

/**
 * Choose which change to go to.
 *
 * @param {Array<{top: number}>} groups - Changes from findChanges().
 * @param {number} scrollTop - Current scroll position of the page.
 * @param {number} viewHeight - Height of the visible part of the page.
 * @param {number} current - Index of the change last jumped to, or -1.
 * @param {number} direction - 1 for next, -1 for previous.
 *
 * @returns {number} Index to go to (wraps around), or -1 if there are none.
 */
export function chooseChange(groups, scrollTop, viewHeight, current, direction,
  stayedPut = false) {
  if (!groups.length) return -1;
  // Where a change is placed after a jump: this far down the visible area.
  const line = scrollTop + viewHeight * 0.3;
  // After a jump the same change is still "here" (also when the page could not
  // scroll far enough to put it at that line: near the end of the page, or two
  // changes in one row); otherwise go by position.
  const here = current >= 0 && current < groups.length &&
    (stayedPut || Math.abs(groups[current].top - line) < 8);
  if (here) {
    return (current + direction + groups.length) % groups.length;
  }
  // Nothing has been jumped to yet: Next starts at the first change that is on
  // screen or below it, which at the top of the page is the top-left one.
  if (direction > 0 && current < 0) {
    const first = groups.findIndex(g => g.top >= scrollTop - 4);
    return first >= 0 ? first : 0;
  }
  if (direction > 0) {
    const next = groups.findIndex(g => g.top > line + 8);
    return next >= 0 ? next : 0;
  }
  let previous = -1;
  groups.forEach((g, i) => {
    if (g.top < line - 8) previous = i;
  });
  return previous >= 0 ? previous : groups.length - 1;
}

// When set, the count label shows this instead of "Change 1 of 2". Without block
// counting the number of stops is only a guess (highlights close together are one
// stop), so the number of characters changed is shown: it is exact.
let countText = '';

/**
 * @param {string} text - What the count label shows while there are changes
 * ('' for the normal "Change 1 of 2").
 */
export function setChangeNavText(text) {
  countText = text || '';
}

function updateCount(index, total) {
  const label = qs('#change-count');
  if (!label) return;
  if (!total) {
    label.textContent = 'No changes';
  } else if (countText) {
    label.textContent = countText;
  } else if (index < 0) {
    label.textContent = total === 1 ? '1 change' : `${total} changes`;
  } else {
    label.textContent = `Change ${index + 1} of ${total}`;
  }
}

function pulse(group) {
  clearTimeout(pulseTimer);
  const frames = () => doc ? doc.querySelectorAll('[data-updatescan-box-frame]') : [];
  if (doc) {
    doc.querySelectorAll(MARK).forEach(el => {
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
    });
    // The brown box around the current change turns orange for a moment too.
    const id = group.block ? String(group.block) : '';
    doc.documentElement.setAttribute('data-updatescan-current-block', id);
    frames().forEach(frame => {
      frame.style.borderColor =
        id && frame.getAttribute('data-updatescan-box-frame') === id ? '#ff5a00' : '#8b5a2b';
    });
  }
  const marked = group.elements;
  marked.forEach(el => {
    el.style.setProperty('outline', '3px solid #ff5a00', 'important');
    el.style.setProperty('outline-offset', '2px', 'important');
  });
  // Long enough to see which one it is.
  pulseTimer = setTimeout(() => {
    marked.forEach(el => {
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
    });
    if (doc) {
      doc.documentElement.setAttribute('data-updatescan-current-block', '');
      frames().forEach(frame => {
        frame.style.borderColor = '#8b5a2b';
      });
    }
  }, 3000);
}

/**
 * Jump to the next or previous change.
 *
 * @param {number} direction - 1 for next, -1 for previous.
 */
export function go(direction) {
  if (!doc || !win) return;
  const changes = currentChanges();
  const viewHeight = win.innerHeight;
  // Still where the last jump put us: a jump a moment ago (its smooth scroll
  // may not be over), or the scroll position has not been moved by hand since.
  const stayedPut = current >= 0 && (
    Date.now() - lastJumpTime < 900 ||
    (lastJumpY !== null && Math.abs(win.scrollY - lastJumpY) < 60));
  const index = chooseChange(changes, win.scrollY, viewHeight, current,
    direction, stayedPut);
  updateCount(index, changes.length);
  if (index < 0) return;
  current = index;
  const group = changes[index];
  describeStop(group);
  const maxY = Math.max(0, doc.documentElement.scrollHeight - viewHeight);
  const target = Math.max(0, group.top - viewHeight * 0.3);
  lastJumpTime = Date.now();
  lastJumpY = Math.min(target, maxY);
  win.scrollTo({top: target, behavior: 'smooth'});
  pulse(group);
}

/**
 * Say what the current stop is, in the tooltip of the count, so a change that
 * is hard to see (an image, a hidden part, text the same colour as its
 * background) can still be identified: hover the count.
 *
 * @param {{elements: Element[]}} group - The stop.
 */
function describeStop(group) {
  const label = qs('#change-count');
  if (!label || !group || !group.elements.length) return;
  const first = group.elements[0];
  const text = group.elements.map((el) => (el.textContent || '').trim())
    .filter(Boolean).join(' / ').replace(/\s+/g, ' ');
  const style = win.getComputedStyle(first);
  const rect = first.getBoundingClientRect();
  const hidden = style.display === 'none' || style.visibility === 'hidden' ||
    Number(style.opacity) === 0 || rect.width < 2 || rect.height < 2;
  const parent = first.parentElement;
  const where = parent ? parent.tagName.toLowerCase() +
    (parent.className && typeof parent.className === 'string' ?
      '.' + parent.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : '';
  label.title = `This change${where ? ` (in ${where})` : ''}: ` +
    (text ? `"${text.slice(0, 200)}"` : 'no text') +
    (hidden ? '\nIt is not visible on the page (hidden or too small to see). ' +
      'To leave it out, use Ignore parts and pick the part around it.' : '');
}

function isTyping(target) {
  return target && target.closest &&
    target.closest('input, select, textarea, [contenteditable="true"]');
}

function onKey(event) {
  if (event.ctrlKey || event.altKey || event.metaKey || isTyping(event.target)) {
    return;
  }
  if (event.key === 'n' || event.key === 'N') {
    event.preventDefault();
    go(1);
  } else if (event.key === 'p' || event.key === 'P') {
    event.preventDefault();
    go(-1);
  }
}

function wireButtons() {
  if (wired) return;
  const next = qs('#change-next');
  const previous = qs('#change-prev');
  if (!next || !previous) return;
  next.addEventListener('click', () => go(1));
  previous.addEventListener('click', () => go(-1));
  wired = true;
}

/**
 * Show the buttons for a page that was just loaded into the Changes view.
 *
 * @param {HTMLIFrameElement} iframe - The iframe showing the changes.
 */
export function showChangeNav(iframe) {
  hideChangeNav();
  doc = iframe.contentDocument;
  win = iframe.contentWindow;
  if (!doc || !win) return;
  wireButtons();
  current = -1;
  groups = null;
  const total = currentChanges().length;
  const bar = qs('#change-nav');
  if (!bar) return;
  if (!total) {
    // Nothing to jump to. If the page does have highlights, but in parts that
    // are not showing, say so instead of making the buttons vanish.
    const unseen = doc.querySelectorAll(MARK).length;
    if (!unseen) {
      bar.classList.add('hidden');
      return;
    }
    const label = qs('#change-count');
    if (label) {
      label.textContent = `${unseen} highlighted in parts of the page that are not showing`;
    }
    for (const id of ['#change-prev', '#change-next']) {
      const button = qs(id);
      if (button) button.disabled = true;
    }
    bar.classList.remove('hidden');
    return;
  }
  for (const id of ['#change-prev', '#change-next']) {
    const button = qs(id);
    if (button) button.disabled = false;
  }
  updateCount(-1, total);
  bar.classList.remove('hidden');
  // N / P work while the page (or the viewer around it) has the keyboard.
  keyHandler = onKey;
  document.addEventListener('keydown', keyHandler);
  doc.addEventListener('keydown', keyHandler);
}

/**
 * Hide the buttons (any view other than the Changes view, or no page).
 */
export function hideChangeNav(keepBar = false) {
  clearTimeout(pulseTimer);
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler);
    try {
      if (doc) doc.removeEventListener('keydown', keyHandler);
    } catch (error) {
      // The frame is already gone.
    }
    keyHandler = null;
  }
  doc = null;
  win = null;
  groups = null;
  current = -1;
  lastJumpTime = 0;
  lastJumpY = null;
  const bar = qs('#change-nav');
  if (bar && !keepBar) bar.classList.add('hidden');
}
