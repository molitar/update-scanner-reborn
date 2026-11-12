/**
 * Pick parts of the LIVE page to ignore or exclude.
 *
 * Injected into the page in the current tab (toolbar, the picker icon). It runs
 * after selector_core.js, which builds the rule for a part. Rules are made from
 * the page's real elements, so they match what the page really is (and what
 * uBlock Origin sees).
 *
 * The picker (its window and the see-through sheet that catches your clicks) lives
 * in its OWN frame in the browser's top layer. Events inside a frame do not pass
 * through the page's own scripts, so a click on an advert or on the picker cannot
 * trigger the advert's click scripts or open a link.
 *
 * See-through layers that ads put over the page are never picked by accident:
 * normally they are treated as if they did not exist. "Show hidden layers" outlines
 * them in red so one can be clicked, selected and hidden like any other part.
 *
 * Nothing on the page is changed for good. The picked parts are saved to the
 * scanned link of this page by the background process (messages live-pick-init
 * and live-pick-save).
 */
(function () {
'use strict';

if (window.__usrLivePicker) {
  window.__usrLivePicker.stop();
  return;
}

const {selectorFor} = globalThis.UsrSelector;
const TODAY = new Date().toISOString().slice(0, 10);
const FULL = 'position:fixed;left:0;top:0;right:0;bottom:0;width:auto;height:auto;margin:0;padding:0;border:0;' +
  'background:transparent;overflow:hidden;max-width:none;max-height:none;z-index:2147483647;';

let holder = null;
let frameEl = null;
let idoc = null;
let originalOpen = null;
let panel = null;
let pageId = null;
let parts = [];
let history = [];
let chain = [];
let index = 0;
let mode = 'exclude';
let hovered = null;
let raf = 0;
let clearTimer = null;
let trapTimer = null;
let previewStyle = null;
let previewOn = false;
let layersOn = false;
let pickVisibleOn = false;
let layers = [];
let traps = new Set();
const layerInfo = new Map();
const layerSeen = new Map();
let firstScan = true;
let selRect = null;
let savedNodes = [];
let pausedLayers = [];
let usePage = false;
let stopped = false;
let pickerTopWatch = 0;
let pickerTopLastRaise = 0;
const ui = {};

function el(tag, props, ...kids) {
  const node = idoc.createElement(tag);
  Object.assign(node, props || {});
  node.append(...kids);
  return node;
}

function shortLabel(element) {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const cls = !id && element.classList.length ? `.${element.classList[0]}` : '';
  return (tag + id + cls).slice(0, 34);
}

function labelFor(element) {
  const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
  return shortLabel(element) + (text ? ` "${text.slice(0, 30)}"` : '');
}

// ---------------------------------------------------------------- interface

const CSS = `
  html, body { margin: 0; height: 100%; background: transparent; cursor: crosshair; overflow: hidden; }
  .box { position: fixed; right: 16px; bottom: 16px; width: 390px; cursor: default;
    font: 13px/1.35 system-ui, sans-serif; color: #e8eef5; background: #142033;
    border: 2px solid #00d5ff; border-radius: 8px; padding: 8px 10px; box-shadow: 0 4px 18px rgba(0,0,0,.5);
    max-height: calc(100vh - 32px); overflow-y: auto; box-sizing: border-box; z-index: 5; }
  .title { font-weight: bold; cursor: move; margin-bottom: 4px; padding-right: 28px; user-select: none; }
  .title span { font-weight: normal; opacity: .6; font-size: 11px; }
  button.close { position: absolute; top: 5px; right: 6px; flex: none; width: 24px; height: 24px; padding: 0;
    font-size: 14px; line-height: 1; border-radius: 12px; background: transparent; border-color: transparent; }
  button.close:hover { background: #c0392b; border-color: #c0392b; }
  .what { font-weight: bold; margin: 4px 0 2px; word-break: break-word; }
  code { display: block; color: #9fe8ff; font: 11px monospace; word-break: break-all; margin-bottom: 4px; }
  .sel { font-weight: bold; margin: 4px 0; padding: 4px 6px; border-radius: 4px; background: #1d2f48; word-break: break-word; }
  .sel.on { background: #0b4f8a; }
  .help { opacity: .9; margin-bottom: 6px; }
  .help div { margin-bottom: 3px; }
  .help .h { font-weight: bold; }
  .help .tip { opacity: .8; font-size: 12px; }
  .row { display: flex; gap: 6px; margin: 4px 0; }
  button { flex: 1; font: inherit; color: #e8eef5; background: #24364f; border: 1px solid #3b5273;
    border-radius: 4px; padding: 5px 8px; cursor: pointer; }
  button:hover:not(:disabled) { background: #2f4768; }
  button:disabled { opacity: .4; cursor: default; }
  button.on { background: #0a8cff; border-color: #0a8cff; font-weight: bold; }
  button.red.on { background: #c0392b; border-color: #c0392b; }
  .status, .small { font-size: 11px; opacity: .8; margin-top: 4px; }
  .controls { display: flex; gap: 10px; margin: 4px 0; }
  .pad { display: grid; grid-template-columns: repeat(3, 42px); grid-template-rows: repeat(3, 34px); gap: 4px; }
  .pad button { padding: 0; font-size: 15px; flex: none; }
  .pad .mid { border: 1px dashed #3b5273; border-radius: 4px; opacity: .5; text-align: center; line-height: 32px; font-size: 10px; }
  .actions { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .actions button { flex: 1; }
  .crumbs { display: flex; flex-wrap: wrap; gap: 3px; margin: 2px 0 6px; max-height: 76px; overflow-y: auto; }
  .crumbs button { flex: 0 0 auto; padding: 1px 5px; font: 11px monospace; }
  .layerlist { max-height: 130px; overflow-y: auto; margin-top: 2px; }
  .layerlist button { display: block; width: 100%; text-align: left; margin: 2px 0; font: 11px monospace; padding: 3px 6px; }
  .layerlist .none { font-size: 12px; opacity: .8; padding: 2px 0; }
  .tiles { display: flex; gap: 6px; margin: 4px 0; }
  .tile { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 4px; }
  .tile svg { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .tile .lbl { font-size: 11px; }
  .tile .chk { font-size: 15px; line-height: 1; }
  .site { margin-top: 6px; padding-top: 4px; border-top: 1px solid #3b5273; }
  .saved { max-height: 150px; overflow-y: auto; margin-top: 4px; border-top: 1px solid #3b5273; padding-top: 4px; }
  .item { margin: 3px 0 6px; }
  .item .rule { font: 11px monospace; color: #9fe8ff; word-break: break-all; }
  .item .tag { font-size: 11px; opacity: .8; }
  .item .row { margin: 2px 0 0; }
  .item button { padding: 2px 6px; flex: 0 0 auto; }
`;

// Reassert the picker's top-layer position if a site opens an advertising
// popover/dialog after our picker. Only active while picking; no site nodes
// are hidden, removed, or modified.
function keepPickerAbovePage() {
  if (stopped || !holder || !frameEl || !holder.isConnected ||
      typeof holder.showPopover !== 'function' ||
      typeof holder.hidePopover !== 'function') return;
  const rect = holder.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 100)));
  const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height / 2, 70)));
  if (x < 0 || y < 0 || rect.width < 20 || rect.height < 20) return;
  const top = document.elementFromPoint(x, y);
  if (top === holder || top === frameEl || holder.contains(top)) return;
  // If a page-created top-layer advert is covering the picker, place the
  // existing picker popover back on top. Throttle retries to avoid a loop.
  const now = Date.now();
  if (now - pickerTopLastRaise < 1500) return;
  pickerTopLastRaise = now;
  try {
    holder.hidePopover();
    holder.showPopover();
  } catch (error) {
    // A browser may reject a top-layer change while opening a modal.
  }
}

async function build() {
  // In the browser's TOP LAYER (a popover), above everything on the page whatever
  // its z-index, so an advert's own layers can never cover it.
  holder = document.createElement('div');
  holder.setAttribute('popover', 'manual');
  holder.setAttribute('data-usr-picker-host', '1');
  holder.style.cssText = FULL;
  frameEl = document.createElement('iframe');
  frameEl.style.cssText = 'all:initial;display:block;width:100%;height:100%;border:0;background:transparent;';
  holder.appendChild(frameEl);
  const loaded = new Promise((resolve) => frameEl.addEventListener('load', resolve, {once: true}));
  frameEl.srcdoc = '<!doctype html><html><head></head><body></body></html>';
  document.documentElement.appendChild(holder);
  try {
    holder.showPopover();
  } catch (error) {
    holder.style.display = 'block'; // an older browser: highest z-index instead
  }
  await loaded;
  pickerTopWatch = setInterval(keepPickerAbovePage, 750);
  idoc = frameEl.contentDocument;
  idoc.head.appendChild(el('style', {textContent: CSS}));

  let build = '';
  try {
    const manifest = browser.runtime.getManifest();
    build = ' v' + (manifest.version_name || manifest.version);
  } catch (error) { /* no manifest */ }
  ui.close = el('button', {className: 'close', textContent: '✕', title: 'Cancel: close the picker without adding the selected part (Escape). Parts you already added stay saved.'});
  ui.title = el('div', {className: 'title'}, 'Pick on this page ', el('span', {textContent: '(drag here to move)' + build}));
  ui.what = el('div', {className: 'what'});
  ui.rule = el('code');
  ui.crumbs = el('div', {className: 'crumbs', title: 'Every box around the part you clicked, from the part itself (left) to the whole page area (right). Click one to select it.'});
  ui.help = el('div', {className: 'help'});
  ui.sel = el('div', {className: 'sel'});
  ui.ignore = el('button', {textContent: 'Ignore', title: 'Left out of the scans only (news, tickers, counters).'});
  ui.noclick = el('button', {textContent: 'Block clicks', title: 'The part stays visible, but clicks go through it to what is underneath. For a picture that is also a hidden ad link: hiding it would lose the picture.'});
  ui.exclude = el('button', {textContent: 'Exclude', title: 'Ads, menu items: hidden on the site and copied as a uBlock Origin filter.'});
  ui.up = el('button', {textContent: '▲', title: 'Up: select the box around it (Up arrow)'});
  ui.down = el('button', {textContent: '▼', title: 'Down: select the part inside (Down arrow)'});
  ui.before = el('button', {textContent: '◀', title: 'Left: select the box just before this one'});
  ui.after = el('button', {textContent: '▶', title: 'Right: select the box just after this one'});
  ui.add = el('button', {textContent: 'Add & Next', title: 'Add it and pick another (Enter)'});
  ui.finish = el('button', {textContent: 'Finish', title: 'Done (Escape)'});
  ui.undo = el('button', {textContent: '↶ Undo'});
  ui.clear = el('button', {textContent: 'Clear all'});
  ui.preview = el('button', {textContent: 'Preview: show what is excluded', title: 'Hides the saved excluded parts and the part you have selected, so you can see the page without them.'});
  ui.layersBtn = el('button', {className: 'red', textContent: 'Show hidden layers', title: 'Ads put see-through layers over the page that steal your clicks. Normally they are ignored here. This outlines them in red so you can click one, press Preview, and add it. Press again to fold it up.'});
  ui.pickVisible = el('button', {textContent: 'Select a visible ad / iframe',
    title: 'Select the topmost visible page element, even when it is not transparent. Does not click the ad or automatically remove it.'});
  ui.layerList = el('div', {className: 'layerlist'});
  ui.enableLayerProtection = el('button', {
    textContent: 'Enable automatic click-layer protection for this site',
    title: 'One site-wide rule for confirmed invisible click interceptors. Does not hide visible dialogs, menus or video players.'
  });
  const SVG = {
    layers: '<svg viewBox="0 0 24 24"><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
    popups: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M9 13l4 4m0-4-4 4"/></svg>',
    menus: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h16"/><path d="m16 13 4 4-2 .5L16.500 20z"/></svg>',
  };
  const tile = (icon, label, title) => {
    const b = el('button', {className: 'tile', title});
    b.innerHTML = `${SVG[icon]}<span class="lbl">${label}</span><span class="chk">☐</span>`;
    return b;
  };
  ui.layersRule = tile('layers', 'Layers', 'Hide see-through layers on this site. Ads put invisible layers over the page that steal your clicks and open ads. Their names change on every visit, so this finds them by what they do and hides them. Needs "Hide excluded parts on sites" on in the toolbar Menu.');
  ui.popupsBtn = tile('popups', 'Pop-ups', 'Block pop-up tabs on this site. Refuses new tabs that a page script opens on its own; links you click yourself still open. Needs "Hide excluded parts on sites" on in the toolbar Menu.');
  ui.usePageBtn = tile('menus', 'Menus', 'Use the page (for menus). Lets you use the page normally, for example to open a menu. Your next click on the page then selects what you click instead of opening it.');
  ui.frameBlock = el('button', {
    textContent: 'Block third-party frames on this site',
    title: 'Stops third-party advertising iframes before they load. May also block legitimate embedded players. Reversible; OFF by default.'
  });
  ui.scriptHost = el('input', {type: 'text', placeholder: 'Third-party script hostname (e.g. ads.example.com)',
    title: 'Exact hostname only. No protocol, paths, wildcards or first-party sites.'});
  ui.scriptHost.style.cssText = 'min-width:0;flex:1;padding:5px;';
  ui.addScript = el('button', {textContent: 'Block script host', title: 'Block scripts from this exact host on this monitored site, when site hiding is enabled.'});
  ui.status = el('div', {className: 'status'});
  ui.savedToggle = el('button', {textContent: 'Saved parts'});
  ui.saved = el('div', {className: 'saved'});
  ui.saved.style.display = 'none';
  panel = el('div', {className: 'box'}, ui.close, ui.title, ui.what, ui.rule, ui.crumbs, ui.help,
    ui.sel,
    el('div', {className: 'row'}, ui.ignore, ui.exclude, ui.noclick),
    el('div', {className: 'controls'},
      el('div', {className: 'pad'},
        el('div'), ui.up, el('div'),
        ui.before, el('div', {className: 'mid', textContent: 'move'}), ui.after,
        el('div'), ui.down, el('div')),
      el('div', {className: 'actions'}, ui.add, ui.finish, ui.undo, ui.clear)),
    el('div', {className: 'row'}, ui.preview),
    el('div', {className: 'row'}, ui.layersBtn),
    el('div', {className: 'row'}, ui.pickVisible), ui.layerList,
    el('div', {className: 'row'}, ui.enableLayerProtection),
    el('div', {className: 'row'}, ui.frameBlock),
    el('div', {className: 'row'}, ui.savedToggle), ui.saved,
    el('div', {className: 'row'}, ui.scriptHost, ui.addScript),
    el('div', {className: 'site'}, el('div', {className: 'small', textContent: 'Tick what you want on for this site (hover for details):'}),
      el('div', {className: 'tiles'}, ui.layersRule, ui.popupsBtn, ui.usePageBtn)),
    ui.status);
  // Boxes drawn over the page: the hover, the selection, the red layers, saved parts.
  ui.layer = el('div');
  ui.layer2 = el('div');
  ui.hoverBox = box('3px dashed rgba(0,213,255,.95)', 'rgba(0,213,255,.08)');
  ui.selectBox = box('4px dashed #00d5ff', 'rgba(0,213,255,.10)');
  ui.layer.append(ui.hoverBox, ui.selectBox);
  idoc.body.append(ui.layer, ui.layer2, panel);
  try {
    frameEl.contentWindow.focus();
  } catch (error) { /* not focusable */ }
}

function box(border, background) {
  const b = el('div');
  b.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;display:none;' +
    `border:${border};background:${background};z-index:1;`;
  return b;
}

function place(b, element) {
  if (!element || !element.isConnected) {
    b.style.display = 'none';
    return;
  }
  const r = element.getBoundingClientRect();
  b.style.display = r.width < 1 && r.height < 1 ? 'none' : 'block';
  b.style.left = `${r.left}px`;
  b.style.top = `${r.top}px`;
  b.style.width = `${r.width}px`;
  b.style.height = `${r.height}px`;
}

// Where a hidden part was (it has no box of its own while it is hidden).
function placeRect(b, r) {
  if (!r || r.w < 1 || r.h < 1) {
    b.style.display = 'none';
    return;
  }
  const dx = r.fixed ? 0 : r.sx - window.scrollX;
  const dy = r.fixed ? 0 : r.sy - window.scrollY;
  b.style.display = 'block';
  b.style.left = `${r.l + dx}px`;
  b.style.top = `${r.t + dy}px`;
  b.style.width = `${r.w}px`;
  b.style.height = `${r.h}px`;
}

// Keeps the boxes on their parts while the page scrolls or moves.
function follow() {
  if (stopped) return;
  const element = chain[index];
  const hidden = element && element.hasAttribute('data-usr-pv');
  place(ui.hoverBox, !usePage && hovered && hovered !== element ? hovered : null);
  if (usePage) place(ui.selectBox, null);
  else if (hidden) placeRect(ui.selectBox, selRect);
  else place(ui.selectBox, element);
  ui.selectBox.style.background = hidden ? 'transparent' : 'rgba(0,213,255,.10)';
  // The saved parts, drawn as grey boxes (the excluded ones are hidden in the preview).
  const marks = [];
  for (const part of parts) {
    if (part.kind === 'layers' || part.kind === 'popups' || part.kind === 'script' || part.kind === 'frames' || part.kind === 'frames' || part.kind === 'frames' || (previewOn && part.kind === 'exclude')) continue;
    try {
      document.querySelectorAll(part.selector).forEach((node) => marks.push(node));
    } catch (error) { /* not valid on this page */ }
  }
  savedNodes = marks;
  while (ui.layer.children.length - 2 < marks.length) {
    ui.layer.appendChild(box('3px dashed #888', 'rgba(120,120,120,.25)'));
  }
  for (let i = 0; i < ui.layer.children.length - 2; i++) {
    place(ui.layer.children[i + 2], usePage ? null : (marks[i] || null));
  }
  // The hidden layers, in red, while "Show hidden layers" is on.
  const shown = layersOn && !previewOn && !usePage ? layers : [];
  while (ui.layer2.children.length < shown.length) {
    ui.layer2.appendChild(box('3px dashed #ff3b30', 'rgba(255,59,48,.12)'));
  }
  for (let i = 0; i < ui.layer2.children.length; i++) {
    place(ui.layer2.children[i], shown[i] && shown[i] !== element ? shown[i] : null);
  }
  if (usePage) holder.style.height = `${Math.min(panel.offsetHeight + 8, window.innerHeight - 8)}px`;
  raf = requestAnimationFrame(follow);
}

// ------------------------------------------------- see-through click layers

// Is this a see-through layer (or inside one)? Normally these are treated as if
// they did not exist, so they are never picked by accident.
function isTrap(node) {
  let n = node;
  for (let i = 0; n && i < 5; i++, n = n.parentElement) {
    if (traps.has(n) || (n.hasAttribute && n.hasAttribute('data-usr-clickthrough'))) return true;
    try {
      const cs = getComputedStyle(n);
      if (cs.position === 'fixed' && Number(cs.opacity) < 0.05) return true;
    } catch (error) { /* gone */ }
  }
  return false;
}

function scanLayers() {
  if (stopped) return;
  const set = new Set();
  let hijack = [];
  try {
    hijack = globalThis.UsrSelector.hijackLayers();
  } catch (error) { /* none */ }
  try {
    // Layers found before stay known while they are hidden (a hidden one cannot be found again).
    traps = new Set([...traps].filter((n) => n.isConnected).concat(globalThis.UsrSelector.findInterceptors([holder])));
    hijack.forEach((n) => traps.add(n));
    traps.forEach((n) => set.add(n));
  } catch (error) { /* keep the old list */ }
  if (layersOn) {
    try {
      globalThis.UsrSelector.findHiddenLayers([holder]).forEach((n) => set.add(n));
    } catch (error) { /* none */ }
    if (chain[0] && layers.includes(chain[0])) set.add(chain[0]);
    layers = [...set];
    for (const n of layers) {
      if (!layerSeen.has(n)) layerSeen.set(n, firstScan ? 0 : Date.now());
      if (getComputedStyle(n).display === 'none') continue;
      const r = n.getBoundingClientRect();
      layerInfo.set(n, {w: Math.round(r.width), h: Math.round(r.height),
        off: r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight});
    }
    firstScan = false;
    renderLayerList();
  }
}

function renderLayerList() {
  ui.layerList.textContent = '';
  if (!layersOn) return;
  const byRule = [...document.querySelectorAll('[data-usr-clickthrough]')]
    .filter((n) => !layers.includes(n) && getComputedStyle(n).display === 'none');
  const alive = layers.filter((n) => n.isConnected && (getComputedStyle(n).display !== 'none' || n.hasAttribute('data-usr-pv')));
  // Only the outer layers that really are see-through traps and are on the screen: the pieces inside
  // them, off-screen parts and ordinary page parts only clutter the list.
  const shown = alive.filter((n) => {
    const info = layerInfo.get(n);
    return isTrap(n) && !(info && info.off) && !alive.some((o) => o !== n && o.contains(n));
  });
  if (byRule.length) {
    ui.layerList.append(el('div', {className: 'none',
      textContent: `Already hidden by the Layers rule on this page: ${byRule.length} (${byRule.slice(0, 4).map(shortLabel).join(', ')}). They cannot take clicks.`}));
  }
  const stale = parts.filter((part) => {
    if (part.kind === 'layers' || part.kind === 'popups' || part.kind === 'script' || part.kind === 'frames' || part.kind === 'frames') return false;
    try {
      return document.querySelectorAll(part.selector).length === 0;
    } catch (error) {
      return true;
    }
  });
  if (stale.length) {
    const b = el('button', {textContent: `✕ Remove ${stale.length} old saved part${stale.length === 1 ? '' : 's'} that no longer match this page`,
      title: stale.map((part) => part.label || part.selector).join('\n')});
    b.addEventListener('click', () => change(parts.filter((p) => !stale.includes(p))));
    ui.layerList.append(el('div', {className: 'none', textContent: 'A layer gets a new name on every visit, so these old ones are useless:'}), b);
  }
  if (!shown.length) {
    ui.layerList.append(el('div', {className: 'none', textContent: 'No other hidden layers on this page.'}));
    return;
  }
  ui.layerList.append(el('div', {className: 'none', textContent: `${shown.length} see-through layer${shown.length === 1 ? '' : 's'} found. Click one here, or inside a red box on the page:`}));
  shown.forEach((node) => {
    const info = layerInfo.get(node) || {w: 0, h: 0, off: false};
    const inner = false;
    const saved = savedFor(node).length ? '✓ saved: ' : '';
    const b = el('button', {textContent: `${saved}${inner ? '↳ ' : ''}${shortLabel(node)}  ${info.w}×${info.h}${info.off ? '  [off-screen]' : ''}${Date.now() - (layerSeen.get(node) || 0) < 10000 ? '  [NEW]' : ''}`, title: labelFor(node)});
    if (chain[0] === node) b.className = 'on';
    b.addEventListener('click', () => choose(node));
    ui.layerList.append(b);
  });
}

// The part of the page under a point: the topmost thing you can SEE.
// Manual mode: the real topmost ad, iframe or overlay may be visible rather than
// transparent. It must still be selectable without executing the ad's click.
function visibleAt(x, y) {
  for (const node of document.elementsFromPoint(x, y)) {
    if (node === holder || node === frameEl || holder.contains(node)) continue;
    if (node === document.body || node === document.documentElement) break;
    if (!node.isConnected || node.closest('[data-usr-picker-host]')) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    return node;
  }
  return null;
}

function under(x, y) {
  for (const node of document.elementsFromPoint(x, y)) {
    if (node === frameEl || node === holder) continue;
    if (node === document.documentElement || node === document.body) return null;
    if (isTrap(node)) continue;
    return node;
  }
  return null;
}

// In the layers view: the smallest red layer around a point.
function layerAt(x, y) {
  let best = null;
  let bestArea = Infinity;
  for (const node of layers) {
    if (!node.isConnected) continue;
    const r = node.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const area = r.width * r.height;
    if (area <= bestArea) {
      best = node;
      bestArea = area;
    }
  }
  return best;
}

// The box just before or after an element (skipping things that show nothing).
function neighbour(element, direction) {
  if (!element) return null;
  const skip = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
  let node = element;
  for (;;) {
    node = direction < 0 ? node.previousElementSibling : node.nextElementSibling;
    if (!node) return null;
    if (!skip.has(node.tagName) && node !== holder) return node;
  }
}

// ----------------------------------------------------------- saved parts

// The saved parts that cover an element: its own rule matches it, or it is
// inside a part that is saved.
function savedFor(element) {
  return parts.filter((part) => {
    if (part.kind === 'layers' || part.kind === 'popups' || part.kind === 'script' || part.kind === 'frames' || part.kind === 'frames') return false;
    try {
      return !!element.closest(part.selector);
    } catch (error) {
      return false;
    }
  });
}

function isSaved(element) {
  return parts.some((part) => {
    if (part.kind === 'layers' || part.kind === 'popups' || part.kind === 'script' || part.kind === 'frames' || part.kind === 'frames') return false;
    try {
      return element.matches(part.selector);
    } catch (error) {
      return false;
    }
  });
}

async function save() {
  preview();
  try {
    await browser.runtime.sendMessage({action: 'live-pick-save', pageId, parts});
  } catch (error) {
    ui.status.textContent = 'Could not save: ' + error;
  }
}

function change(next) {
  history.push(parts);
  parts = next;
  save();
  render();
}

function ruleOn(kind) {
  return parts.find((p) => p.kind === kind);
}

// Excluded parts stay visible (outlined in grey) so they can be selected again;
// with the preview on they are hidden, together with the part selected right now.
function preview() {
  if (!previewStyle) {
    previewStyle = document.createElement('style');
    document.documentElement.appendChild(previewStyle);
  }
  const rules = [];
  for (const part of (previewOn ? parts : [])) {
    if (part.kind !== 'exclude') continue;
    try {
      document.createDocumentFragment().querySelector(part.selector);
      rules.push(`${part.selector} { display: none !important; }`);
    } catch (error) { /* skip */ }
  }
  document.querySelectorAll('[data-usr-pv]').forEach((n) => n.removeAttribute('data-usr-pv'));
  document.querySelectorAll('[data-usr-pvl]').forEach((n) => n.removeAttribute('data-usr-pvl'));
  const now = chain[index];
  // In the layers view a selected layer is previewed at once.
  // Only Exclude hides the part: Ignore and Block clicks leave it on the page. A see-through
  // layer selected in the layers view is hidden so you can check the page without it.
  if (now && !savedFor(now).length && ((mode === 'exclude' && (previewOn || layersOn)) || (layersOn && isTrap(now)))) {
    now.setAttribute('data-usr-pv', '1');
    rules.push('[data-usr-pv] { display: none !important; }');
  }
  previewStyle.textContent = rules.join('\n');
}

function measure() {
  selRect = null;
  const node = chain[index];
  if (!node) return;
  document.querySelectorAll('[data-usr-pv]').forEach((n) => n.removeAttribute('data-usr-pv'));
  const r = node.getBoundingClientRect();
  let fixed = false;
  try {
    fixed = getComputedStyle(node).position === 'fixed';
  } catch (error) { /* gone */ }
  selRect = {l: r.left, t: r.top, w: r.width, h: r.height, sx: window.scrollX, sy: window.scrollY, fixed};
}

function showIndex(i) {
  index = i;
  measure();
  preview();
  render();
}

function choose(target) {
  if (!target || target === document.body || target === document.documentElement) return;
  chain = [];
  for (let node = target; node && node !== document.body && node !== document.documentElement;
    node = node.parentElement) {
    chain.push(node);
  }
  showIndex(0);
}

function reset() {
  chain = [];
  index = 0;
  selRect = null;
  preview();
  render();
}

function add() {
  const element = chain[index];
  if (!element) return;
  const covered = savedFor(element);
  if (covered.length) {
    // Stop ignoring: take the saved part(s) off again.
    change(parts.filter((p) => !covered.includes(p)));
    reset();
    return;
  }
  const selector = selectorFor(document, element);
  // Do not save selectors made only of DOM positions. Ads rebuild these
  // elements on every load and such rules can later hide unrelated controls.
  if (globalThis.UsrSelector.positionOnly(selector)) {
    ui.status.textContent = 'Unstable element: no reliable selector. Use automatic Layers protection or block its script host.';
    return;
  }
  change([...parts, {
    selector, label: labelFor(element).slice(0, 120),
    ...(mode === 'exclude' ? {kind: 'exclude'} : (mode === 'noclick' ? {kind: 'noclick'} : {})), added: TODAY,
  }]);
  reset();
}

// ---------------------------------------------------------------- render

function setTile(button, on) {
  button.className = on ? 'tile on' : 'tile';
  button.querySelector('.chk').textContent = on ? '☑' : '☐';
}

function render() {
  if (ui.frameBlock) {
    const on = !!ruleOn('frames');
    ui.frameBlock.textContent = on ? 'Disable third-party frame blocking (ON)' : 'Block third-party frames on this site (OFF)';
    ui.frameBlock.className = on ? 'on' : '';
  }
  if (ui.enableLayerProtection) {
    ui.enableLayerProtection.textContent = ruleOn('layers') ?
      'Disable automatic click-layer protection for this site' :
      'Enable automatic click-layer protection for this site';
  }
  const element = chain[index];
  ui.ignore.className = mode === 'ignore' ? 'on' : '';
  ui.exclude.className = mode === 'exclude' ? 'on' : '';
  ui.noclick.className = mode === 'noclick' ? 'on' : '';
  ui.before.disabled = !neighbour(element, -1);
  ui.after.disabled = !neighbour(element, 1);
  ui.up.disabled = !element || index >= chain.length - 1;
  ui.down.disabled = !element || index <= 0;
  ui.add.disabled = !element;
  ui.sel.className = element ? 'sel on' : 'sel';
  if (element) {
    const size = selRect ? `${Math.round(selRect.w)}×${Math.round(selRect.h)}` : '';
    ui.sel.textContent = `Selected: ${shortLabel(element)}  ${size}  (step ${index + 1} of ${chain.length})`;
  } else {
    ui.sel.textContent = layersOn ? 'Click a red layer on the page' : 'Nothing selected yet';
  }
  const covered = element ? savedFor(element) : [];
  ui.add.textContent = covered.length ? 'Stop ignoring' : 'Add & Next';
  ui.preview.textContent = previewOn ? 'Preview on: excluded parts are hidden' : 'Preview: show what is excluded';
  ui.preview.className = previewOn ? 'on' : '';
  ui.pickVisible.className = pickVisibleOn ? 'on' : '';
  ui.pickVisible.textContent = pickVisibleOn ? 'Selection armed: click the visible ad' : 'Select a visible ad / iframe';
  ui.layersBtn.className = layersOn ? 'red on' : 'red';
  ui.layersBtn.textContent = layersOn ? 'Hidden layers shown in red: press to fold up' : 'Show hidden layers';
  setTile(ui.layersRule, !!ruleOn('layers'));
  setTile(ui.popupsBtn, !!ruleOn('popups'));
  setTile(ui.usePageBtn, usePage);
  ui.undo.disabled = history.length === 0;
  ui.undo.textContent = history.length ? `↶ Undo (${history.length})` : '↶ Undo';
  renderCrumbs();
  renderSaved();
  renderLayerList();
  if (!element) {
    ui.what.textContent = '';
    ui.rule.textContent = '';
    ui.help.textContent = '';
    ui.help.append(
      el('div', {className: 'h', textContent: pickVisibleOn ? 'Visible-ad selection' : (layersOn ? 'Hidden layers' : 'Select an area on the page')}),
      el('div', {textContent: pickVisibleOn ?
        'Click the visible ad or iframe once. The picker captures the click without activating the ad. Inspect its selection before adding an exclusion. Press the button again to cancel.' : (layersOn ?
        'The red boxes are see-through layers over the page. Click one to select it: it disappears so you can see the page without it. Layers that only appear when the page sees your mouse: tick Menus and move the mouse over the page.' :
        'Click the smallest area you can of the part you want gone, for example a thumbnail or a line of its text.')}),
      el('div', {className: 'h', textContent: 'Choose what to do with it'}),
      el('div', {textContent: 'Ignore: stays on the page, the scans skip it (news, counters). Exclude: hidden on the site and copied for uBlock (ads, menus). Block clicks: stays visible, but clicks go through it (a picture that is also a hidden ad link).'}));
  } else {
    ui.what.textContent = `Step ${index + 1} of ${chain.length}: ${labelFor(element)}`;
    try {
      ui.rule.textContent = selectorFor(document, element);
    } catch (error) {
      ui.rule.textContent = '';
    }
    ui.help.textContent = '';
    if (covered.length) {
      ui.help.append(el('div', {className: 'h', textContent: (isSaved(element) ? 'This part is saved (' : 'This is inside a saved part (') +
        (covered[0].kind === 'exclude' ? 'Exclude' : 'Ignore') + '). Press Stop ignoring to put it back.'}));
    } else if (isTrap(element)) {
      ui.help.append(el('div', {className: 'h', textContent: 'A see-through layer. It is hidden now so you can check the page. Add & Next saves it. Its name changes on every visit, so tick Layers (below) as well to catch it every time.'}));
    }
    ui.help.append(
      el('div', {textContent: '▲ selects a bigger box, ▼ a smaller one. Preview shows the page without it; then Add & Next.'}));
  }
  const excluded = parts.filter((p) => p.kind === 'exclude').length;
  const ignored = parts.filter((p) => !p.kind || p.kind === 'ignore').length;
  const blockedCount = parts.filter((p) => p.kind === 'noclick').length;
  if (pageId !== null && !ui.status.textContent.startsWith('Saved:')) {
    ui.status.textContent = parts.length ? `${ignored} ignored, ${excluded} excluded${blockedCount ? `, ${blockedCount} click-blocked` : ''} (saved)` : 'Nothing saved yet';
  }
}

function renderCrumbs() {
  ui.crumbs.textContent = '';
  chain.forEach((element, i) => {
    const covered = savedFor(element).length > 0;
    const b = el('button', {textContent: (covered ? '✓ ' : '') + shortLabel(element),
      title: (isSaved(element) ? 'Saved. ' : (covered ? 'Inside a saved part. ' : '')) + labelFor(element)});
    if (i === index) b.className = 'on';
    b.addEventListener('click', () => showIndex(i));
    ui.crumbs.append(b);
  });
}

function renderSaved() {
  const list = parts.filter((p) => p.kind !== 'layers' && p.kind !== 'popups');
  const scripts = list.filter((p) => p.kind === 'script');
  const excluded = list.filter((p) => p.kind === 'exclude').length;
  const blocked = list.filter((p) => p.kind === 'noclick').length;
  ui.savedToggle.textContent = `Saved parts: ${list.length - excluded - blocked - scripts.length} ignored, ${excluded} excluded` + (blocked ? `, ${blocked} click-blocked` : '') + (scripts.length ? `, ${scripts.length} script hosts ` : ' ') +
    (ui.saved.style.display === 'none' ? '▾' : '▴');
  ui.saved.textContent = '';
  if (!list.length) ui.saved.append(el('div', {className: 'tag', textContent: 'None saved yet.'}));
  list.forEach((part) => {
    const kind = el('button', {textContent: part.kind === 'exclude' ? 'Make ignore' : 'Make exclude'});
    if (part.kind === 'noclick' || part.kind === 'script') kind.style.display = 'none';
    kind.addEventListener('click', () => {
      change(parts.map((p) => (p !== part ? p : (p.kind === 'exclude' ?
        {selector: p.selector, label: p.label, added: p.added} : {...p, kind: 'exclude'}))));
    });
    const remove = el('button', {textContent: 'Remove'});
    remove.addEventListener('click', () => change(parts.filter((p) => p !== part)));
    ui.saved.append(el('div', {className: 'item'},
      el('div', {className: 'tag', textContent: `${part.kind === 'exclude' ? 'Exclude' : (part.kind === 'noclick' ? 'Blocks clicks' : (part.kind === 'script' ? 'Blocks script host' : 'Ignore'))}: ${part.label || ''}`}),
      el('div', {className: 'rule', textContent: part.selector}),
      el('div', {className: 'row'}, kind, remove)));
  });
}

// ---------------------------------------------------------------- events

function overPanel(event) {
  return panel && panel.contains(event.target);
}

// What a click or the mouse is on: in the layers view only a red layer counts,
// otherwise only what you can see.
function target(x, y) {
  const node = pickVisibleOn ? visibleAt(x, y) : (layersOn ? layerAt(x, y) : under(x, y));
  // A saved part (a grey box) can be selected again by clicking inside it, even when the
  // page's own hit test lands elsewhere (a part that no longer takes clicks, a layer
  // above it, or the layers view).
  let best = null;
  let bestArea = Infinity;
  for (const saved of savedNodes) {
    if (!saved.isConnected || (node && saved.contains(node))) continue;
    const r = saved.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const area = r.width * r.height;
    if (area <= bestArea) {
      best = saved;
      bestArea = area;
    }
  }
  return best || node;
}

function onClick(event) {
  if (overPanel(event)) return;
  event.preventDefault();
  const node = target(event.clientX, event.clientY);
  if (node) {
    choose(node);
    if (pickVisibleOn) { pickVisibleOn = false; render(); }
  } else if (layersOn && !pickVisibleOn) {
    ui.sel.textContent = 'No see-through layer here yet. Some layers only appear when the page sees your mouse: tick Menus, move the mouse over the page, and they are added to the list.';
  }
}

function onMove(event) {
  hovered = overPanel(event) ? null : target(event.clientX, event.clientY);
  if (layersOn && !pickVisibleOn && !overPanel(event)) learnAt(event.clientX, event.clientY);
}

// Layers under the mouse that the scan did not find (small ones, or made late).
function learnAt(x, y) {
  try {
    // The picker's own sheet is not the page: look at the page under it.
    for (const node of globalThis.UsrSelector.invisibleAt(x, y, [holder])) {
      if (traps.has(node)) continue;
      traps.add(node);
      if (!layers.includes(node)) {
        layers.push(node);
        layerSeen.set(node, Date.now());
        const r = node.getBoundingClientRect();
        layerInfo.set(node, {w: Math.round(r.width), h: Math.round(r.height), off: false});
        renderLayerList();
      }
    }
  } catch (error) { /* page changed */ }
}

// With "Use the page" on, the page sees your real mouse, so it makes the layers that
// wait for it. Every layer under the mouse is then added to the list.
let lastLearn = 0;
function onPageMove(event) {
  if (!layersOn || !usePage || overPanel(event)) return;
  const now = Date.now();
  if (now - lastLearn < 150) return;
  lastLearn = now;
  learnAt(event.clientX, event.clientY);
}

// While "Use the page" is on, the next click on the page selects instead of acting.
function onPageClick(event) {
  if (event.target === holder) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  choose(under(event.clientX, event.clientY));
}

// Scrolling with the wheel over the sheet scrolls the page underneath.
function onWheel(event) {
  if (overPanel(event)) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? window.innerHeight : 1);
  window.scrollBy(event.deltaX * unit, event.deltaY * unit);
}

function onKey(event) {
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const swallow = () => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  if (event.key === 'ArrowUp' && chain[index]) {
    swallow();
    if (index < chain.length - 1) showIndex(index + 1);
  } else if (event.key === 'ArrowDown' && chain[index]) {
    swallow();
    if (index > 0) showIndex(index - 1);
  } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && chain[index]) {
    swallow();
    const next = neighbour(chain[index], event.key === 'ArrowLeft' ? -1 : 1);
    if (next) choose(next);
  } else if (event.key === 'Enter' && chain[index]) {
    swallow();
    add();
  } else if (event.key === 'Escape') {
    swallow();
    stop();
  }
}

function setLayers(on) {
  layersOn = on;
  if (on) {
    scanLayers();
    preview();
    clearInterval(trapTimer);
    trapTimer = setInterval(scanLayers, 1500);
    // The list is on screen: everything else is treated as before.
  } else {
    layers = [];
    preview();
    clearInterval(trapTimer);
    trapTimer = setInterval(scanLayers, 5000);
  }
  render();
}

// "Use the page": shrink the sheet to the window so the page gets the mouse.
function setUsePage(on) {
  if (on === usePage) return;
  const r = panel.getBoundingClientRect();
  usePage = on;
  if (on) {
    panel.style.left = '4px';
    panel.style.top = '4px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.maxHeight = `${window.innerHeight - 16}px`;
    holder.style.cssText = FULL.replace('right:0;bottom:0;width:auto;height:auto;', '') +
      `left:${Math.max(0, Math.round(r.left - 4))}px;top:${Math.max(0, Math.round(r.top - 4))}px;` +
      `width:${Math.round(r.width + 8)}px;height:${Math.round(r.height + 8)}px;`;
    document.addEventListener('click', onPageClick, true);
  } else {
    document.removeEventListener('click', onPageClick, true);
    const left = parseFloat(holder.style.left) || 0;
    const top = parseFloat(holder.style.top) || 0;
    holder.style.cssText = FULL;
    panel.style.left = `${left + 4}px`;
    panel.style.top = `${top + 4}px`;
    panel.style.maxHeight = '';
  }
  render();
}

function dragPanel() {
  let start = null;
  ui.title.addEventListener('mousedown', (event) => {
    const r = panel.getBoundingClientRect();
    start = {x: event.screenX, y: event.screenY, left: r.left, top: r.top,
      hleft: parseFloat(holder.style.left) || 0, htop: parseFloat(holder.style.top) || 0};
    event.preventDefault();
  });
  idoc.addEventListener('mousemove', (event) => {
    if (!start) return;
    const dx = event.screenX - start.x;
    const dy = event.screenY - start.y;
    // A compact iframe is only as wide as its holder. Moving the panel
    // inside that iframe clips the picker; move the holder instead.
    if (usePage || !pageId) {
      const maxLeft = Math.max(0, window.innerWidth - holder.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - holder.offsetHeight);
      holder.style.left = `${Math.min(maxLeft, Math.max(0, start.hleft + dx))}px`;
      holder.style.top = `${Math.min(maxTop, Math.max(0, start.htop + dy))}px`;
    } else {
      const maxLeft = Math.max(0, idoc.documentElement.clientWidth - panel.offsetWidth);
      const maxTop = Math.max(0, idoc.documentElement.clientHeight - panel.offsetHeight);
      panel.style.left = `${Math.min(maxLeft, Math.max(0, start.left + dx))}px`;
      panel.style.top = `${Math.min(maxTop, Math.max(0, start.top + dy))}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  }, true);
  idoc.addEventListener('mouseup', () => {
    start = null;
  }, true);
}

function stop() {
  stopped = true;
  clearInterval(pickerTopWatch);
  pickerTopWatch = 0;
  cancelAnimationFrame(raf);
  clearTimeout(clearTimer);
  clearInterval(trapTimer);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('click', onPageClick, true);
  document.removeEventListener('mousemove', onPageMove, true);
  if (holder) {
    try {
      holder.hidePopover();
    } catch (error) { /* not open */ }
    holder.remove();
  }
  restorePopups();
  document.querySelectorAll('[data-usr-pv]').forEach((n) => n.removeAttribute('data-usr-pv'));
  if (previewStyle) previewStyle.remove();
  pauseLiveHide(false);
  pauseLayerRule(false);
  window.__usrLivePicker = null;
  // Let the page hear focus events again a moment after the frame is gone.
  setTimeout(() => {
    window.__usrPicking = false;
  }, 600);
}

// Pop-up windows are refused while picking, as one more safeguard.
function blockPopups() {
  try {
    originalOpen = window.wrappedJSObject.open;
    window.wrappedJSObject.open = exportFunction(() => null, window.wrappedJSObject);
  } catch (error) {
    originalOpen = null;
  }
}

function restorePopups() {
  try {
    if (originalOpen) window.wrappedJSObject.open = originalOpen;
  } catch (error) { /* page is gone */ }
  originalOpen = null;
}

// The Layers rule is paused while you pick, so the layers it hides can be listed,
// selected and checked. They are put back when the picker closes.
function pauseLayerRule(paused) {
  if (paused) {
    pausedLayers = [];
    document.querySelectorAll('[data-usr-clickthrough]').forEach((n) => {
      pausedLayers.push([n, n.style.getPropertyValue('display') === 'none']);
      n.style.removeProperty('display');
      n.style.removeProperty('pointer-events');
    });
  } else {
    for (const [n, hidden] of pausedLayers) {
      n.style.setProperty('pointer-events', 'none', 'important');
      if (hidden) n.style.setProperty('display', 'none', 'important');
    }
    pausedLayers = [];
  }
}

// The content script that hides excluded parts on visits is paused while you
// pick, so the excluded parts can be seen and selected again.
function pauseLiveHide(paused) {
  const style = document.getElementById('usr-live-hide-style');
  if (style) style.disabled = paused;
}

// ---------------------------------------------------------------- start

async function start() {
  window.__usrLivePicker = {stop, selected: () => (chain[index] ? shortLabel(chain[index]) + ' ' + index + '/' + chain.length : null),
    layers: () => layers.map((n) => shortLabel(n)), scan: () => {
      scanLayers();
      return traps.size;
    }};
  window.__usrPicking = true;
  pauseLiveHide(true);
  pauseLayerRule(true);
  await build();
  if (stopped) return;
  ui.close.addEventListener('click', stop);
  dragPanel();
  let answer;
  try {
    answer = await browser.runtime.sendMessage({action: 'live-pick-init', url: location.href});
  } catch (error) {
    answer = {ok: false, reason: String(error)};
  }
  if (!answer || !answer.ok) {
    // Not a scanned page: only the window, so the page stays usable.
    holder.style.cssText = FULL.replace('left:0;top:0;right:0;bottom:0;width:auto;height:auto;', '') +
      'left:4px;top:4px;right:auto;bottom:auto;width:430px;height:auto;';
    panel.style.left = '4px';
    panel.style.top = '4px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.maxHeight = `${window.innerHeight - 16}px`;
    ui.what.textContent = 'This site is not in your monitored sites.';
    ui.help.textContent = 'Add any page on this site to Update Scanner first (toolbar, New), then pick again.';
    ui.rule.textContent = '';
    [ui.ignore, ui.exclude, ui.noclick, ui.up, ui.down, ui.before, ui.after, ui.add, ui.preview, ui.layersBtn, ui.layersRule,
      ui.popupsBtn, ui.usePageBtn, ui.undo, ui.clear, ui.savedToggle, ui.scriptHost, ui.addScript, ui.enableLayerProtection, ui.frameBlock, ui.pickVisible].forEach((b) => {
      b.disabled = true;
    });
    ui.finish.textContent = 'Close';
    ui.finish.addEventListener('click', stop);
    // Recalculate after the disabled buttons and Close label finish layout.
    const sizeCompactPicker = () => {
      if (stopped || pageId || !holder || !holder.isConnected) return;
      const height = Math.min(panel.offsetHeight + 8, window.innerHeight - 8);
      holder.style.height = `${Math.max(60, height)}px`;
      const maxTop = Math.max(0, window.innerHeight - holder.offsetHeight);
      holder.style.top = `${Math.min(maxTop, Math.max(0, parseFloat(holder.style.top) || 0))}px`;
    };
    sizeCompactPicker();
    requestAnimationFrame(sizeCompactPicker);
    return;
  }
  pageId = answer.pageId;
  parts = answer.parts || [];
  ui.status.textContent = `Saving to: ${answer.title}`;
  blockPopups();
  idoc.addEventListener('click', onClick, true);
  idoc.addEventListener('mousemove', onMove, true);
  idoc.addEventListener('wheel', onWheel, {capture: true, passive: false});
  idoc.addEventListener('contextmenu', (event) => event.preventDefault(), true);
  idoc.addEventListener('keydown', onKey, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousemove', onPageMove, {capture: true, passive: true});
  ui.ignore.addEventListener('click', () => {
    mode = 'ignore';
    render();
  });
  ui.exclude.addEventListener('click', () => {
    mode = 'exclude';
    render();
  });
  ui.noclick.addEventListener('click', () => {
    mode = 'noclick';
    render();
  });
  ui.up.addEventListener('click', () => {
    if (index < chain.length - 1) showIndex(index + 1);
  });
  ui.down.addEventListener('click', () => {
    if (index > 0) showIndex(index - 1);
  });
  ui.before.addEventListener('click', () => {
    const next = neighbour(chain[index], -1);
    if (next) choose(next);
  });
  ui.after.addEventListener('click', () => {
    const next = neighbour(chain[index], 1);
    if (next) choose(next);
  });
  ui.add.addEventListener('click', add);
  ui.finish.addEventListener('click', () => {
    if (chain[index]) add();
    stop();
  });
  ui.undo.addEventListener('click', () => {
    if (!history.length) return;
    parts = history.pop();
    save();
    reset();
  });
  ui.clear.addEventListener('click', () => {
    if (!parts.length) return;
    if (ui.clear.textContent === 'Clear all') {
      ui.clear.textContent = `Really clear ${parts.length}?`;
      clearTimer = setTimeout(() => {
        ui.clear.textContent = 'Clear all';
      }, 4000);
      return;
    }
    clearTimeout(clearTimer);
    ui.clear.textContent = 'Clear all';
    change([]);
  });
  ui.preview.addEventListener('click', () => {
    previewOn = !previewOn;
    preview();
    render();
  });
  ui.layersBtn.addEventListener('click', () => setLayers(!layersOn));
  ui.pickVisible.addEventListener('click', () => { pickVisibleOn = !pickVisibleOn; render(); });
  ui.frameBlock.addEventListener('click', () => {
    const on = !!ruleOn('frames');
    change(on ? parts.filter(p => p.kind !== 'frames') :
      [...parts, {selector: ':urs1-block-third-party-frames', kind: 'frames',
        label: 'Block external iframes (may affect video embeds)', added: TODAY}]);
    ui.status.textContent = on ? 'External frames unblocked. Reload this site.' :
      'External frame blocking enabled. Reload to prevent recurring ad frames; embedded videos may be affected.';
  });
  ui.enableLayerProtection.addEventListener('click', () => {
    const enabled = ruleOn('layers');
    change(enabled ? parts.filter((p) => p.kind !== 'layers') :
      [...parts, {selector: ':usr-click-layers', label: 'Automatically protect against invisible click layers',
        kind: 'layers', hide: true, added: TODAY}]);
    ui.status.textContent = enabled ? 'Automatic click-layer protection disabled for this site.' :
      'Automatic click-layer protection enabled. Reload to apply it throughout this site.';
  });
  ui.layersRule.addEventListener('click', () => {
    change(ruleOn('layers') ? parts.filter((p) => p.kind !== 'layers') :
      [...parts, {selector: ':usr-click-layers', label: 'See-through click layers (hidden)', kind: 'layers', hide: true, added: TODAY}]);
  });
  ui.addScript.addEventListener('click', () => {
    const host = ui.scriptHost.value.trim().toLowerCase().replace(/\.$/, '');
    const valid = host.length <= 253 && host.includes('.') &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
    const site = location.hostname.toLowerCase().replace(/^www\./, '');
    if (!valid || host === site || host.endsWith('.' + site)) {
      ui.status.textContent = 'Enter an exact third-party hostname only (no URL, wildcard or first-party host).';
      return;
    }
    const selector = ':urs1-block-script:' + host;
    if (parts.some((p) => p.selector === selector)) {
      ui.status.textContent = 'This script host is already blocked. Remove it under Saved parts to unblock.';
      return;
    }
    change([...parts, {selector, label: host, kind: 'script', added: TODAY}]);
    ui.scriptHost.value = '';
    ui.status.textContent = 'Script host saved. Reload the website to prevent the script from starting.';
  });
  ui.popupsBtn.addEventListener('click', () => {
    change(ruleOn('popups') ? parts.filter((p) => p.kind !== 'popups') :
      [...parts, {selector: ':usr-block-popups', label: 'Block pop-ups opened by scripts', kind: 'popups', added: TODAY}]);
  });
  ui.usePageBtn.addEventListener('click', () => setUsePage(!usePage));
  ui.savedToggle.addEventListener('click', () => {
    ui.saved.style.display = ui.saved.style.display === 'none' ? 'block' : 'none';
    renderSaved();
  });
  dragPanel();
  preview();
  render();
  scanLayers();
  trapTimer = setInterval(scanLayers, 5000);
  follow();
}

start();
})();
