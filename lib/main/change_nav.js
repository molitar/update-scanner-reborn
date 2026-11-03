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
const MARK = '[data-updatescan-diff-highlight="1"]';

let doc = null;
let win = null;
let groups = null;
let groupsHeight = 0;
let current = -1;
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
  const found = [];
  const memo = new Map();
  for (const element of doc.querySelectorAll(MARK)) {
    if (!element.getClientRects().length) continue; // hidden: nothing to see
    if (isPinned(element, memo)) continue;
    const rect = element.getBoundingClientRect();
    const top = rect.top + win.scrollY;
    const bottom = top + rect.height;
    const last = found[found.length - 1];
    if (last && top - last.bottom <= GROUP_GAP) {
      last.bottom = Math.max(last.bottom, bottom);
      last.elements.push(element);
    } else {
      found.push({top, bottom, elements: [element]});
    }
  }
  return found;
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
    const first = group.elements[0].getBoundingClientRect();
    const last = group.elements[group.elements.length - 1]
      .getBoundingClientRect();
    group.top = first.top + win.scrollY;
    group.bottom = last.bottom + win.scrollY;
  }
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
export function chooseChange(groups, scrollTop, viewHeight, current, direction) {
  if (!groups.length) return -1;
  // Where a change is placed after a jump: this far down the visible area.
  const line = scrollTop + viewHeight * 0.3;
  // After a jump the same change is still "here"; otherwise go by position.
  const here = current >= 0 && current < groups.length &&
    Math.abs(groups[current].top - line) < 8;
  if (here) {
    return (current + direction + groups.length) % groups.length;
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

function updateCount(index, total) {
  const label = qs('#change-count');
  if (!label) return;
  if (!total) {
    label.textContent = 'No changes';
  } else if (index < 0) {
    label.textContent = total === 1 ? '1 change' : `${total} changes`;
  } else {
    label.textContent = `Change ${index + 1} of ${total}`;
  }
}

function pulse(group) {
  clearTimeout(pulseTimer);
  const marked = group.elements;
  marked.forEach(el => {
    el.style.setProperty('outline', '3px solid #ff5a00', 'important');
    el.style.setProperty('outline-offset', '2px', 'important');
  });
  pulseTimer = setTimeout(() => {
    marked.forEach(el => {
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
    });
  }, 1400);
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
  const index = chooseChange(changes, win.scrollY, viewHeight, current,
    direction);
  updateCount(index, changes.length);
  if (index < 0) return;
  current = index;
  const group = changes[index];
  win.scrollTo({top: Math.max(0, group.top - viewHeight * 0.3),
    behavior: 'smooth'});
  pulse(group);
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
    // Nothing is highlighted: nothing to jump to.
    bar.classList.add('hidden');
    return;
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
export function hideChangeNav() {
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
  const bar = qs('#change-nav');
  if (bar) bar.classList.add('hidden');
}
