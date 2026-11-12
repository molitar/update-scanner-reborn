/**
 * The "Ignore parts" picker.
 *
 * Shows the saved page (View New Page) and lets the user pick parts of it that
 * this link should ignore, such as a rotating news ticker or a visitor counter.
 *
 * - Move the pointer: the part under it is outlined.
 * - Click: that part is selected. Then step ABOVE it (the box around it) or
 *   BELOW it (back toward what you clicked) with the Larger / Smaller buttons
 *   or the Up / Down arrow keys, until exactly the right part is outlined.
 * - "Ignore this part" (or Enter) adds it. Clicking something that is already
 *   ignored offers "Stop ignoring this part".
 * - "Done" (or Escape) leaves the picker.
 *
 * Parts are saved as a CSS selector plus a short label (see
 * lib/scan/excluded_parts.js). The picker works on the page shown in the frame:
 * the frame is sandboxed from the page's own scripts, but this module may
 * listen to and style its document.
 */

import {normaliseParts} from '/lib/scan/excluded_parts.js';

const STYLE_ID = 'updatescan-pick-style';
const HOVER = 'data-updatescan-pick-hover';
const SELECTED = 'data-updatescan-pick-selected';
const EXCLUDED = 'data-updatescan-pick-excluded';

const qs = (selector) => document.querySelector(selector);

// The selector code is shared with the live-page picker.
import '/lib/live_picker/selector_core.js';

const {selectorFor, positionOnly, stableClass, stableId} = globalThis.UsrSelector;
export {selectorFor, positionOnly};

function snippet(element, length = 50) {
  const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function labelFor(element) {
  const tag = element.tagName.toLowerCase();
  const name = element.id && stableId(element.id) ? `#${element.id}` :
    ([...element.classList].filter(stableClass)[0] ?
      `.${[...element.classList].filter(stableClass)[0]}` : '');
  const text = snippet(element, 40);
  return `${tag}${name}${text ? ` “${text}”` : ''}`;
}

/**
 * Start picking.
 *
 * @param {object} options - What to work on.
 * @param {Page} options.page - The page whose ignored parts are being edited.
 * @param {HTMLIFrameElement} options.iframe - The frame showing the page.
 * @param {Function} options.onChange - Called with the new list of parts each
 * time one is added or removed.
 * @param {Function} options.onDone - Called when the picker is closed.
 *
 * @returns {Function} Call it to stop the picker.
 */
export function startPicker({page, iframe, onChange, onDone}) {
  let parts = normaliseParts(page.excludedParts);
  let doc = null;
  let chain = [];
  let index = 0;
  let stopped = false;
  const bar = qs('#pick-bar');
  const text = qs('#pick-text');
  const add = qs('#pick-add');
  const larger = qs('#pick-larger');
  const smaller = qs('#pick-smaller');
  const done = qs('#pick-done');
  const list = qs('#pick-list');
  const undo = qs('#pick-undo');
  const clear = qs('#pick-clear');
  const modeInclude = qs('#pick-mode-include');
  const modeIgnore = qs('#pick-mode-ignore');
  const modeExclude = qs('#pick-mode-exclude');
  // What Add & Next adds: 'ignore' (scans only) or 'exclude' (also a uBlock rule).
  let mode = 'ignore';
  const setMode = (next) => {
    mode = next;
    modeInclude.classList.toggle('default', mode === 'include');
    modeIgnore.classList.toggle('default', mode === 'ignore');
    modeExclude.classList.toggle('default', mode === 'exclude');
  };
  const onModeInclude = () => setMode('include');
  const onModeIgnore = () => setMode('ignore');
  const onModeExclude = () => setMode('exclude');
  modeInclude.addEventListener('click', onModeInclude);
  modeIgnore.addEventListener('click', onModeIgnore);
  modeExclude.addEventListener('click', onModeExclude);
  setMode('ignore');
  // Every state of the list before a change, so Undo can step back (also after
  // Clear all).
  const history = [];
  let clearTimer = null;

  // Only an exact selector targeting this element is an existing rule.
  // Never remove an ancestor rule just because the user clicked a child.
  const matchesPart = (element) => parts.filter((part) => {
    try {
      return element.matches(part.selector);
    } catch (error) {
      return false;
    }
  });

  const markExcluded = () => {
    doc.querySelectorAll(`[${EXCLUDED}]`)
      .forEach((element) => element.removeAttribute(EXCLUDED));
    let missing = 0;
    for (const part of parts) {
      let found = 0;
      try {
        doc.querySelectorAll(part.selector).forEach((element) => {
          element.setAttribute(EXCLUDED, '1');
          found++;
        });
      } catch (error) {
        // Not valid: counted as missing.
      }
      if (!found) missing++;
    }
    const excluded = parts.filter((part) => part.kind === 'exclude').length;
    const included = parts.filter((part) => part.kind === 'include').length;
    const counts = excluded ?
      `${included} included, ${parts.length - excluded - included} ignored, ${excluded} excluded` :
      `${included} included, ${parts.length - included} ignored`;
    list.textContent = parts.length ?
      `${counts}${missing ? ` (${missing} not found on this page)` : ''}` :
      'No parts selected yet';
  };

  const clearSelection = () => {
    doc.querySelectorAll(`[${SELECTED}]`)
      .forEach((element) => element.removeAttribute(SELECTED));
    chain = [];
    index = 0;
    add.disabled = true;
    larger.disabled = true;
    smaller.disabled = true;
    text.textContent = 'Click the part of the page to select (such as a ' +
      'rotating news ticker or a visitor counter). Then use \u25b2 Up / \u25bc Down ' +
      '(or the arrow keys) until the cyan dashed outline covers exactly that ' +
      'part, and press Add & Next.';
  };

  const showSelection = () => {
    doc.querySelectorAll(`[${SELECTED}]`)
      .forEach((element) => element.removeAttribute(SELECTED));
    const element = chain[index];
    if (!element) return clearSelection();
    element.setAttribute(SELECTED, '1');
    const already = matchesPart(element);
    add.textContent = already.length ? 'Already added' : 'Add & Next';
    add.disabled = !!already.length;
    larger.disabled = index >= chain.length - 1;
    smaller.disabled = index <= 0;
    // What is selected, which step of the way up it is, and the rule that would
    // be saved for it.
    text.textContent = '';
    const heading = document.createElement('div');
    heading.className = 'pick-what';
    heading.textContent = `Step ${index + 1} of ${chain.length}: ${labelFor(element)}  -  ${
      (element.textContent || '').trim().length} characters`;
    const rule = document.createElement('code');
    rule.className = 'pick-rule';
    try {
      rule.textContent = selectorFor(doc, element);
    } catch (error) {
      rule.textContent = '';
    }
    const help = document.createElement('div');
    help.textContent = (already.length ?
      'This element already has a saved rule. Choose a different element or remove the rule from settings. ' : '') +
      '▲ Up selects the box around it, ▼ Down goes back inside. When the ' +
      'cyan dashed outline covers exactly the right part, press Add & Next ' +
      'to add it and pick another.';
    text.append(heading, rule, help);
  };

  const choose = (target) => {
    if (!target || target === doc.body || target === doc.documentElement) return;
    chain = [];
    for (let node = target;
      node && node !== doc.body && node !== doc.documentElement;
      node = node.parentElement) {
      chain.push(node);
    }
    index = 0;
    showSelection();
  };

  const changed = (next) => {
    history.push(parts);
    parts = next;
    onChange(parts);
    markExcluded();
    clearSelection();
    undo.disabled = false;
  };

  const resetClearButton = () => {
    clearTimeout(clearTimer);
    clear.textContent = 'Clear all';
  };

  // Clear all asks for a second press: it is easy to press by mistake.
  const onClear = () => {
    if (!parts.length) return;
    if (clear.textContent === 'Clear all') {
      clear.textContent = `Really clear ${parts.length}?`;
      clearTimer = setTimeout(resetClearButton, 4000);
      return;
    }
    resetClearButton();
    changed([]);
  };

  const onUndo = () => {
    if (!history.length) return;
    parts = history.pop();
    onChange(parts);
    markExcluded();
    clearSelection();
    undo.disabled = history.length === 0;
    resetClearButton();
  };

  const toggle = () => {
    const element = chain[index];
    if (!element) return;
    const already = matchesPart(element);
    if (already.length) return; // Add & Next must never delete saved rules.
    const selector = selectorFor(doc, element);
    if (!selector || /data-updatescan-pick-/i.test(selector)) {
      text.textContent = 'Could not create a persistent selector. Pick another element.';
      return;
    }
    // Selectors can intentionally match several equivalent page components;
    // adding the same selector twice must not overwrite or remove the first.
    if (parts.some((part) => part.selector === selector)) {
      text.textContent = 'This selector is already saved. Pick another element.';
      return;
    }
    changed(normaliseParts([...parts,
      {selector, label: labelFor(element),
        ...(mode !== 'ignore' ? {kind: mode} : {}),
        added: new Date().toISOString().slice(0, 10)}]));
  };

  // Empty, oversized click targets used by advertising overlays can sit over
  // the actual cards. Hit-test through these while selecting: we never remove
  // them from the saved snapshot or change the site's rules.
  const isClickShield = (element) => {
    if (!element || element.nodeType !== 1 ||
        !element.matches('a[href], [role="link"], [onclick]')) return false;
    if ((element.textContent || '').trim() ||
        element.querySelector('img, picture, video, canvas, svg, iframe')) return false;
    const rect = element.getBoundingClientRect();
    const view = doc.defaultView;
    const area = Math.max(1, view.innerWidth * view.innerHeight);
    return rect.width > 0 && rect.height > 0 &&
      rect.width * rect.height >= area * 0.2;
  };

  const targetAtPointer = (event) => {
    // Temporarily disable only confirmed empty, oversized click targets,
    // hit-test the actual deepest child, then restore all original styles.
    // Merely selecting an item must not persist changes to the saved page.
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      const temporarilyDisabled = [];
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const top = doc.elementFromPoint(event.clientX, event.clientY);
          if (!isClickShield(top)) return top;
          const oldValue = top.style.getPropertyValue('pointer-events');
          const oldPriority = top.style.getPropertyPriority('pointer-events');
          temporarilyDisabled.push({element: top, oldValue, oldPriority});
          top.style.setProperty('pointer-events', 'none', 'important');
        }
        const underneath = doc.elementFromPoint(event.clientX, event.clientY);
        if (underneath && !isClickShield(underneath)) return underneath;
      } finally {
        for (const {element, oldValue, oldPriority} of temporarilyDisabled) {
          if (oldValue) element.style.setProperty('pointer-events', oldValue, oldPriority);
          else element.style.removeProperty('pointer-events');
        }
      }
    }
    return isClickShield(event.target) ? null : event.target;
  };

  let lastHover = null;
  const onOver = (event) => {
    const target = targetAtPointer(event);
    if (lastHover === target) return;
    if (lastHover) lastHover.removeAttribute(HOVER);
    lastHover = target && target.nodeType === 1 && target !== doc.body &&
      target !== doc.documentElement ? target : null;
    if (lastHover) lastHover.setAttribute(HOVER, '1');
  };

  const onClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    choose(targetAtPointer(event));
    // So the arrow keys go to the picker, not to the page's own scrolling.
    try {
      iframe.contentWindow.focus();
    } catch (error) {
      // The frame is gone.
    }
  };

  const onKey = (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index < chain.length - 1) {
        index++;
        showSelection();
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (index > 0) {
        index--;
        showSelection();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      toggle();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      stop();
    }
  };

  const onLarger = () => {
    if (index < chain.length - 1) {
      index++;
      showSelection();
    }
  };
  const onSmaller = () => {
    if (index > 0) {
      index--;
      showSelection();
    }
  };

  // Finish: a part still outlined and not yet added is added first.
  function finish() {
    const element = chain[index];
    if (element && !matchesPart(element).length) toggle();
    stop();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(waiter);
    add.removeEventListener('click', toggle);
    larger.removeEventListener('click', onLarger);
    smaller.removeEventListener('click', onSmaller);
    done.removeEventListener('click', finish);
    undo.removeEventListener('click', onUndo);
    modeInclude.removeEventListener('click', onModeInclude);
    modeIgnore.removeEventListener('click', onModeIgnore);
    modeExclude.removeEventListener('click', onModeExclude);
    clear.removeEventListener('click', onClear);
    clearTimeout(clearTimer);
    handle.removeEventListener('pointerdown', onDragStart);
    handle.removeEventListener('pointermove', onDragMove);
    handle.removeEventListener('pointerup', onDragEnd);
    handle.removeEventListener('pointercancel', onDragEnd);
    window.removeEventListener('keydown', onKey, true);
    if (doc) {
      try {
        doc.removeEventListener('pointermove', onOver, true);
        doc.removeEventListener('click', onClick, true);
        doc.defaultView.removeEventListener('keydown', onKey, true);
        const style = doc.getElementById(STYLE_ID);
        if (style) style.remove();
        for (const name of [HOVER, SELECTED, EXCLUDED]) {
          doc.querySelectorAll(`[${name}]`)
            .forEach((element) => element.removeAttribute(name));
        }
      } catch (error) {
        // The frame is already gone.
      }
    }
    bar.classList.add('hidden');
    onDone();
  }

  // The window can be dragged by its title so it never covers what you want to pick.
  const handle = qs('#pick-handle');
  let dragOffset = null;
  const onDragStart = (event) => {
    const box = bar.getBoundingClientRect();
    dragOffset = {x: event.clientX - box.left, y: event.clientY - box.top};
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onDragMove = (event) => {
    if (!dragOffset) return;
    const left = Math.max(0, Math.min(window.innerWidth - 60, event.clientX - dragOffset.x));
    const top = Math.max(0, Math.min(window.innerHeight - 40, event.clientY - dragOffset.y));
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
  };
  const onDragEnd = () => {
    dragOffset = null;
  };
  handle.addEventListener('pointerdown', onDragStart);
  handle.addEventListener('pointermove', onDragMove);
  handle.addEventListener('pointerup', onDragEnd);
  handle.addEventListener('pointercancel', onDragEnd);

  bar.classList.remove('hidden');
  text.textContent = 'Loading the page...';
  add.disabled = true;
  larger.disabled = true;
  smaller.disabled = true;
  add.addEventListener('click', toggle);
  larger.addEventListener('click', onLarger);
  smaller.addEventListener('click', onSmaller);
  done.addEventListener('click', finish);
  undo.addEventListener('click', onUndo);
  clear.addEventListener('click', onClear);
  undo.disabled = true;
  clear.textContent = 'Clear all';
  window.addEventListener('keydown', onKey, true);

  // The page shows in the frame a moment after it is created.
  const waiter = setInterval(() => {
    const candidate = iframe.contentDocument;
    if (!candidate || candidate.URL !== 'about:srcdoc' || !candidate.body ||
        !candidate.body.childNodes.length) {
      return;
    }
    clearInterval(waiter);
    doc = candidate;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      * { cursor: crosshair !important; }
      [${HOVER}] { outline: 1px dashed rgba(0, 213, 255, 0.8) !important; outline-offset: -1px !important; }
      [${EXCLUDED}] { opacity: 0.3 !important; outline: 3px dashed #888 !important; outline-offset: -2px !important; }
      [${SELECTED}] { outline: 4px dashed #00d5ff !important; outline-offset: -2px !important; background-color: rgba(0, 213, 255, 0.10) !important; }
    `;
    (doc.head || doc.documentElement).appendChild(style);
    doc.addEventListener('pointermove', onOver, true);
    doc.addEventListener('click', onClick, true);
    doc.defaultView.addEventListener('keydown', onKey, true);
    markExcluded();
    clearSelection();
  }, 100);

  return stop;
}
