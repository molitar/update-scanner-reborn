/**
 * Hides the parts you EXCLUDED when you visit a site (an advert, a menu entry,
 * a bar), if you turned on "Hide excluded parts on sites" in the toolbar Menu.
 *
 * A content script that runs in every page. It asks the background process for
 * the excluded parts of the scanned pages on this site, and adds a style that
 * hides them. Nothing else on the page is touched, and nothing is hidden while
 * the setting is off. (This hides after the page loads: it does not stop an
 * advert from downloading, which a blocker such as uBlock Origin can.)
 */
(function () {
'use strict';

if (window.top !== window || !/^https?:$/.test(location.protocol)) return;

// While the picker is open (window.__usrPicking, set by live_picker.js), the
// page must not hear the focus and pointer-leaving events the picker's frame
// causes: adverts use them to guess a click on a frame (the window loses focus)
// or an exit (the mouse leaves at the top edge) and open a pop-up. This script
// runs before any script of the page, so these listeners come first.
const GUARDED = ['blur', 'focus', 'focusin', 'focusout', 'visibilitychange',
  'mouseout', 'mouseleave', 'mouseover', 'mouseenter',
  'pointerout', 'pointerleave', 'pointerover', 'pointerenter'];
const guard = (event) => {
  if (window.__usrPicking) event.stopImmediatePropagation();
};
for (const name of GUARDED) {
  window.addEventListener(name, guard, true);
  document.addEventListener(name, guard, true);
}

// Some ad scripts take every click on the page: they cancel it (so a link does
// not open) and open their advert instead. With the site rule "Block pop-ups
// opened by scripts" on, a real click of yours on an ordinary link to the same
// site is hidden from the page's own scripts, so the link works. These listeners
// are put in place immediately (before the page's scripts) and only act once the
// rule is known to be on for this site.
let protectLinks = false;
const LINK_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick'];
for (const name of LINK_EVENTS) {
  window.addEventListener(name, (event) => {
    if (!protectLinks || !event.isTrusted || window.__usrPicking) return;
    if (globalThis.UsrSelector && globalThis.UsrSelector.isChallengePage()) return;
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
    if (/^_?blank$/i.test(link.target || '')) return;
    let sameSite = false;
    try {
      sameSite = new URL(link.href).origin === location.origin;
    } catch (error) {
      sameSite = false;
    }
    if (sameSite) event.stopImmediatePropagation();
  }, true);
}

// Block script-created windows only for sites where the user enabled the
// 'Block pop-ups opened by scripts' rule.  In Firefox, content scripts run in
// an isolated world, so changing the content script's window.open would not
// affect the page.  exportFunction installs the blocker in the page world.
// The existing live picker uses the same Firefox mechanism while picking.
function blockScriptPopups() {
  try {
    if (typeof exportFunction !== 'function' || !window.wrappedJSObject) return false;
    const pageWindow = window.wrappedJSObject;
    pageWindow.open = exportFunction(function () { return null; }, pageWindow);
    return true;
  } catch (error) {
    console.warn('[Update Scanner Reborn] Could not enable script popup blocking:', error);
    return false;
  }
}

const STYLE_ID = 'usr-live-hide-style';

// The hijack that does not depend on the layer: an EMPTY link (no text, picture or
// background) to another site that opens a new tab, which is what an ad network puts
// inside its see-through layer. Whatever its layer is called, whatever it looks like, a
// click on such a link is cancelled and the link and the layers around it are switched
// off, so the next click goes to the page. Both site rules (layers and pop-ups) use it.
function isHijackLink(link) {
  try {
    if (!link || !link.href) return false;
    const url = new URL(link.href);
    if (!/^https?:$/.test(url.protocol)) return false;
    const strip = (host) => host.replace(/^www\./, '');
    const mine = strip(location.hostname);
    const theirs = strip(url.hostname);
    if (theirs === mine || theirs.endsWith('.' + mine) || mine.endsWith('.' + theirs)) return false;
    if (!/^_?blank$/i.test(link.target || '')) return false;
    if ((link.innerText || '').trim() || link.querySelector('img, svg, video, canvas, picture, input, button')) return false;
    const cs = getComputedStyle(link);
    return cs.backgroundImage === 'none' && cs.borderTopStyle === 'none';
  } catch (error) {
    return false;
  }
}

function switchOffAround(link, hide) {
  let node = link;
  for (let i = 0; node && i < 7 && node !== document.body && node !== document.documentElement; i++, node = node.parentElement) {
    let cs;
    try {
      cs = getComputedStyle(node);
    } catch (error) {
      break;
    }
    const placed = cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky';
    if (node !== link && !(placed && (Number(cs.opacity) < 0.2 || !(node.innerText || '').trim()))) break;
    node.style.setProperty('pointer-events', 'none', 'important');
    if (hide) node.style.setProperty('display', 'none', 'important');
    node.setAttribute('data-usr-clickthrough', '1');
  }
}

function startHijackGuard(hide) {
  const stopIt = (event) => {
    if (!event.isTrusted || window.__usrPicking) return;
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!isHijackLink(link)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'click' || event.type === 'auxclick') switchOffAround(link, hide);
  };
  for (const name of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick']) {
    window.addEventListener(name, stopIt, true);
  }
  // Before the click, as the mouse arrives, so even the first click is not taken.
  let last = 0;
  window.addEventListener('mousemove', (event) => {
    if (!event.isTrusted || window.__usrPicking) return;
    const now = Date.now();
    if (now - last < 80) return;
    last = now;
    for (const node of document.elementsFromPoint(event.clientX, event.clientY).slice(0, 6)) {
      const link = node.closest ? node.closest('a[href]') : null;
      if (isHijackLink(link)) {
        switchOffAround(link, hide);
        break;
      }
    }
  }, {capture: true, passive: true});
}

// Hidden click layers: see-through layers that take clicks and open an ad.
// Their names are made up fresh on every load, so a saved selector would go
// stale. When the site has the "click-through" part, they are found on each visit
// and made click-through (pointer-events: none), so the click reaches the page.
function startClickThrough(mode) {
  let timer = null;
  // Strictly limited to empty, viewport-covering overlays. Never disable
  // visible dialogs, embedded video players, or a site's genuine controls.
  const neutralizeScreenTraps = () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!vw || !vh || !document.body) return;
    for (const node of document.querySelectorAll('a[href], div, section')) {
      if (node.hasAttribute('data-usr-clickthrough')) continue;
      const cs = getComputedStyle(node);
      if (!['fixed', 'absolute'].includes(cs.position) || cs.pointerEvents === 'none' ||
          cs.visibility !== 'visible' || cs.display === 'none') continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < vw * 0.70 || rect.height < vh * 0.70 ||
          rect.left > vw * 0.15 || rect.top > vh * 0.15 ||
          rect.right < vw * 0.85 || rect.bottom < vh * 0.85) continue;
      if ((parseInt(cs.zIndex, 10) || 0) < 1000) continue;
      if (node.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover]') ||
          node.querySelector('video, iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) continue;
      const transparent = Number(cs.opacity) < 0.08 ||
        (cs.backgroundColor === 'transparent' || cs.backgroundColor === 'rgba(0, 0, 0, 0)');
      if (!transparent || (node.innerText || '').trim() ||
          node.querySelector('button, input, select, textarea, video, canvas')) continue;
      node.style.setProperty('pointer-events', 'none', 'important');
      if (mode === 'hide') node.style.setProperty('display', 'none', 'important');
      node.setAttribute('data-usr-clickthrough', '1');
    }
  };
  const run = () => {
    timer = null;
    if (window.__usrPicking) return;
    let layers = [];
    try {
      // Never on a Cloudflare check, and only on CONFIRMED interceptors.
      if (globalThis.UsrSelector.isChallengePage()) return;
      layers = globalThis.UsrSelector.findInterceptors([]);
    } catch (error) {
      return;
    }
    for (const node of layers) {
      node.style.setProperty('pointer-events', 'none', 'important');
      if (mode === 'hide') node.style.setProperty('display', 'none', 'important');
      node.setAttribute('data-usr-clickthrough', '1');
    }
    neutralizeScreenTraps();
  };
  const later = (ms = 300) => {
    if (!timer) timer = setTimeout(run, ms);
  };
  // Just in time: whatever see-through layer is under the mouse is made click-through
  // before the click, so layers made late (or only over a row) cannot take it.
  let lastMove = 0;
  const neutralize = (event) => {
    if (window.__usrPicking || !event.isTrusted) return;
    const now = Date.now();
    if (event.type === 'mousemove' && now - lastMove < 60) return;
    lastMove = now;
    try {
      if (globalThis.UsrSelector.isChallengePage()) return;
      for (const node of globalThis.UsrSelector.invisibleAt(event.clientX, event.clientY, [])) {
        node.style.setProperty('pointer-events', 'none', 'important');
        if (mode === 'hide') node.style.setProperty('display', 'none', 'important');
        node.setAttribute('data-usr-clickthrough', '1');
      }
    } catch (error) { /* page changed */ }
  };
  window.addEventListener('mousemove', neutralize, {capture: true, passive: true});
  window.addEventListener('pointerdown', neutralize, {capture: true, passive: true});
  window.addEventListener('mousedown', neutralize, {capture: true, passive: true});
  const begin = () => {
    run();
    [1000, 3000, 6000, 12000, 25000].forEach((ms) => setTimeout(run, ms));
    // Layers are usually added to the body late (and made again if removed):
    // look again when the body or the page's top level grows, at most every
    // half second.
    if (document.body) {
      // Ad overlays commonly arrive several levels below body, or get rebuilt
      // without adding a top-level child. Debounce the subtree observer.
      new MutationObserver(() => later(500)).observe(document.body, {childList: true, subtree: true});
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', begin, {once: true});
  } else {
    begin();
  }
}

async function run() {
  let answer;
  try {
    answer = await browser.runtime.sendMessage({action: 'live-hide-rules', url: location.href});
  } catch (error) {
    return;
  }
  if (answer && (answer.clickLayers || answer.blockPopups)) startHijackGuard(answer.clickLayers ? answer.clickLayers === 'hide' : true);
  if (answer && answer.clickLayers) startClickThrough(answer.clickLayers);
  if (answer && answer.blockPopups) {
    protectLinks = true;
    blockScriptPopups();
  }
  const rules = answer && Array.isArray(answer.rules) ? answer.rules : [];
  const noClick = answer && Array.isArray(answer.noClick) ? answer.noClick : [];
  if (!rules.length && !noClick.length) return;
  const css = [];
  for (const selector of rules) {
    try {
      document.createDocumentFragment().querySelector(selector);
      // A site's own stylesheet may use a more specific !important rule
      // (e.g. .td-js-loaded .td-scroll-up[data-style="style1"]). The
      // deliberately nonexistent IDs increase specificity without matching
      // fewer elements. Keep this as a CSS rule so late DOM updates and
      // class changes are handled without a mutation loop.
      css.push(`:is(${selector}):not(#__usr_hide_priority_1):not(#__usr_hide_priority_2):not(#__usr_hide_priority_3) { display: none !important; }`);
    } catch (error) {
      // Not valid CSS: skipped.
    }
  }
  // Parts that stay visible but must not take clicks (a picture that is also a hidden ad link).
  for (const selector of noClick) {
    try {
      document.createDocumentFragment().querySelector(selector);
      css.push(`${selector} { pointer-events: none !important; }`);
    } catch (error) {
      // Not valid CSS: skipped.
    }
  }
  if (!css.length) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css.join('\n');
  (document.head || document.documentElement).appendChild(style);
}

run();
})();
