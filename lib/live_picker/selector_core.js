/**
 * Builds the CSS selector ("rule") for a part of a page. Shared by the picker in
 * the saved page (lib/main/exclude_picker.js) and the picker on the live page
 * (lib/live_picker/live_picker.js). It is a plain script, not a module, so it
 * can be injected into a web page: it puts what it offers on
 * globalThis.UsrSelector.
 */
(function () {
'use strict';

// Classes that change with the page's state, or that look generated, make poor
// selectors: they would stop matching on the next scan.
const STATE_WORDS =
  /(^|[-_])(active|current|selected|open|opened|show|shown|hover|focus|hidden|visible|loaded|loading|collapsed|expanded|is|has)([-_]|$)/i;

function stableClass(name) {
  return !!name && name.length <= 30 && !/\d{3,}/.test(name) &&
    !/^[a-f0-9]{8,}$/i.test(name) && !STATE_WORDS.test(name);
}

/**
 * @param {string} selector - A CSS selector.
 *
 * @returns {boolean} True if it names no class, id or attribute anywhere, so it
 * depends only on tags and positions.
 */
function positionOnly(selector) {
  return !/[.#[]/.test(selector.replace(/:nth-child\(\d+\)/g, ''));
}

function stableId(id) {
  return !!id && id.length <= 40 && !/\d{4,}/.test(id) &&
    !/^[a-f0-9]{8,}$/i.test(id);
}

/**
 * @param {Element} node - An element without a usable class or id.
 *
 * @returns {string} An attribute selector for it, such as
 * `[style="max-width:100%;overflow-x:auto;"]` or `[data-zoneid="5629970"]`, or ''
 * when it has nothing stable to point at.
 */
function attributeFragment(node) {
  const quote = (value) => `"${value.replace(/[\\"]/g, '\\$&')}"`;
  const style = (node.getAttribute('style') || '').trim();
  if (style.length >= 8 && style.length <= 120) {
    // A long run of decimals (100.000000000000000001%) is made up fresh on each
    // load by some adverts: match what is before and after it, not the number.
    const long = style.match(/\.\d{4,}/);
    if (long) {
      const before = style.slice(0, long.index + 1);
      const after = style.slice(long.index + long[0].length);
      return `[style^=${quote(before)}]` + (after ? `[style$=${quote(after)}]` : '');
    }
    return `[style=${quote(style)}]`;
  }
  for (const {name, value} of node.attributes) {
    // Picker-only markers are transient; persisting them makes rules
    // match only while the picker is open (never during scans).
    if (/^data-updatescan-pick-/i.test(name)) continue;
    if (/^data-/.test(name) && value.length >= 1 && value.length <= 40 &&
        !/^[a-f0-9]{12,}$/i.test(value)) {
      return `[${name}=${quote(value)}]`;
    }
  }
  return '';
}

/**
 * A selector for an element that has no class or id, built from something
 * inside it that points to ANOTHER site (the advertiser): for example
 * `body > div:has(a[href*="ads.example"])`. Positions change when a script adds
 * an element; the advertiser does not. Returns '' when there is no such thing or
 * the selector would hit anything but look-alike parts that do not contain each
 * other.
 *
 * @param {Document} doc - The page's document.
 * @param {Element} element - The part to point at.
 *
 * @returns {string} The selector, or ''.
 */
function markerSelector(doc, element) {
  const parent = element.parentElement;
  if (!parent) return '';
  const escape = (text) => doc.defaultView.CSS.escape(text);
  let prefix = '';
  if (parent === doc.body) {
    prefix = 'body > ';
  } else if (stableId(parent.id)) {
    prefix = `#${escape(parent.id)} > `;
  } else {
    const classes = [...parent.classList].filter(stableClass).slice(0, 2);
    if (!classes.length) return '';
    prefix = `${parent.tagName.toLowerCase()}${classes.map((c) => `.${escape(c)}`).join('')} > `;
  }
  const hostOf = (value) => {
    try {
      const url = new URL(value, doc.baseURI);
      return /^https?:$/.test(url.protocol) ? url.hostname.replace(/^www\./, '') : '';
    } catch (error) {
      return '';
    }
  };
  // The site's own address: the one most links go to.
  const tally = new Map();
  doc.querySelectorAll('a[href]').forEach((link) => {
    const host = hostOf(link.getAttribute('href'));
    if (host) tally.set(host, (tally.get(host) || 0) + 1);
  });
  const own = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const tag = element.tagName.toLowerCase();
  for (const [selector, attribute] of
    [['a[href]', 'href'], ['iframe[src]', 'src'], ['img[src]', 'src']]) {
    for (const node of element.querySelectorAll(selector)) {
      const host = hostOf(node.getAttribute(attribute));
      if (!host || (own && host === own[0])) continue;
      const candidate = `${prefix}${tag}:has(${node.tagName.toLowerCase()}[${attribute}*="${host}"])`;
      try {
        const found = [...doc.querySelectorAll(candidate)];
        const alone = found.every((one) =>
          one.tagName === element.tagName &&
          !found.some((other) => other !== one && one.contains(other)));
        if (found.includes(element) && alone && found.length <= 8) return candidate;
      } catch (error) {
        // This browser cannot use :has(); no such selector.
      }
    }
  }
  return '';
}

/**
 * @param {Document} doc - The page's document.
 * @param {Element} element - The part to point at.
 *
 * @returns {string} A CSS selector that matches exactly that part.
 */
function selectorFor(doc, element) {
  const escape = (text) => doc.defaultView.CSS.escape(text);
  const segment = (node) => {
    const tag = node.tagName.toLowerCase();
    if (stableId(node.id)) {
      return {selector: `#${escape(node.id)}`, anchored: true};
    }
    const classes = [...node.classList].filter(stableClass).slice(0, 2);
    let selector = tag + classes.map((name) => `.${escape(name)}`).join('');
    // No class to hold on to: an inline style or a data attribute is a better
    // anchor than a position (adverts often have just that).
    let byAttribute = false;
    if (!classes.length) {
      const fragment = attributeFragment(node);
      selector += fragment;
      byAttribute = fragment !== '';
    }
    const parent = node.parentElement;
    // A part found by an attribute is not given a position: look-alike siblings
    // are the same kind of part (the second banner slot) and a position changes.
    if (parent && !byAttribute) {
      const alike = [...parent.children].filter((child) => child.matches(selector));
      if (alike.length > 1) {
        const position = [...parent.children].indexOf(node) + 1;
        selector += `:nth-child(${position})`;
      }
    }
    return {selector, anchored: false, byAttribute};
  };

  const segments = [];
  for (let node = element;
    node && node.nodeType === 1 && node !== doc.body &&
    node !== doc.documentElement;
    node = node.parentElement) {
    const part = segment(node);
    segments.unshift(part.selector);
    const candidate = segments.join(' > ');
    try {
      const found = doc.querySelectorAll(candidate);
      // A selector made only of positions ("div:nth-child(23)") is unique in the
      // saved copy but breaks as soon as the live page has one more element
      // (an advert, a banner added by a script), and it can match other parts of
      // the site. Keep climbing until a class or an id is part of it.
      if (found.length === 1 && found[0] === element && !positionOnly(candidate)) {
        return candidate;
      }
      // An attribute-anchored part may have look-alikes (two banner slots with
      // the same style): fine when there are a few and none holds another.
      if (part.byAttribute && segments.length === 1 && found.length <= 6 &&
          [...found].includes(element) &&
          [...found].every((one) => one.tagName === element.tagName &&
            ![...found].some((other) => other !== one && one.contains(other)))) {
        return candidate;
      }
    } catch (error) {
      // Try a longer one.
    }
    if (part.anchored) break;
  }

  // No class or id to hold on to (an advert slot made of bare divs): point at
  // it by what is inside, a link, frame or picture that goes to another site.
  const marked = markerSelector(doc, element);
  if (marked) return marked;

  // No class or id anywhere above: the first selector that was unique.
  {
    const plain = [];
    for (let node = element;
      node && node.nodeType === 1 && node !== doc.body && node !== doc.documentElement;
      node = node.parentElement) {
      plain.unshift(segment(node).selector);
      const candidate = plain.join(' > ');
      try {
        const found = doc.querySelectorAll(candidate);
        if (found.length === 1 && found[0] === element) return candidate;
      } catch (error) {
        // Try a longer one.
      }
    }
  }

  // Always unique: every level by its position.
  const path = [];
  for (let node = element;
    node && node.nodeType === 1 && node !== doc.documentElement;
    node = node.parentElement) {
    const parent = node.parentElement;
    path.unshift(parent ?
      `${node.tagName.toLowerCase()}:nth-child(${
        [...parent.children].indexOf(node) + 1})` :
      node.tagName.toLowerCase());
  }
  return 'html > ' + path.join(' > ');
}


// See-through parts that sit over the page and take clicks: positioned (fixed,
// absolute or sticky), big enough to be clicked, with nothing to see in them
// (transparent or invisible, no text, picture or border), and either clickable
// (a link, a frame, a pointer cursor, a click handler) or high up in the stack.
// Used by the picker (to list them) and by the content script that makes them
// click-through on a site.
// A page that is a Cloudflare check: nothing on it may be touched.
function isChallengePage() {
  return /^just a moment|attention required/i.test(document.title || '') ||
    /\/cdn-cgi\//.test(location.href) ||
    !!document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-stage, ' +
      '#cf-chl-widget, [name="cf-turnstile-response"], .cf-turnstile');
}

// Things that must never be made click-through: dialogs, frames, controls.
function isProtected(node) {
  if (node.closest('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover]')) return true;
  if (node.tagName === 'IFRAME') {
    // A see-through frame from an ad network (not a Cloudflare check) is a layer, not content.
    const clear = Number(getComputedStyle(node).opacity) < 0.1;
    if (!clear || /challenges\.cloudflare\.com/.test(node.src || '')) return true;
  }
  if (node.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile')) return true;
  return false;
}

// What looks like nothing: invisible, or transparent with nothing in it.
function seemsInvisible(node, cs) {
  const clear = cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent';
  const invisible = Number(cs.opacity) < 0.05;
  // A picture, video, frame or control IS something to see.
  const content = /^(IMG|VIDEO|CANVAS|SVG|PICTURE|OBJECT|EMBED|INPUT|BUTTON|SELECT|TEXTAREA|AUDIO)$/i.test(node.tagName);
  const nothingInside = !content && !(node.innerText || '').trim() &&
    !node.querySelector('img, video, canvas, svg, picture, input, button, textarea, select') &&
    cs.backgroundImage === 'none' && cs.borderTopStyle === 'none' && cs.boxShadow === 'none';
  return invisible || (clear && nothingInside);
}

// CONFIRMED interceptors: for the links and buttons on screen, whatever sits ABOVE
// the centre of one (and is not the control or its own parent or child) and shows
// nothing. Only these are made click-through, never a guess.
function findInterceptors(skip) {
  const ignore = skip || [];
  const found = new Set();
  const controls = [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]')]
    .filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 &&
        r.top < window.innerHeight && r.left < window.innerWidth;
    }).slice(0, 120);
  for (const control of controls) {
    const r = control.getBoundingClientRect();
    const stack = document.elementsFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 1),
      Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 1));
    for (const el of stack) {
      if (el === control || control.contains(el) || el.contains(control)) break;
      if (ignore.some((one) => one === el || one.contains(el))) continue;
      if (el === document.body || el === document.documentElement) break;
      if (isProtected(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
      if (seemsInvisible(el, cs)) found.add(el);
    }
  }
  // A fixed, see-through layer covering most of the window is a click trap whatever
  // lies under it (this is the pattern ad networks use), and so is every link inside it.
  if (document.body) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const el of document.body.querySelectorAll('*')) {
      if (found.size > 60) break;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || Number(cs.opacity) >= 0.05 || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.6 || r.height < vh * 0.6 || isProtected(el)) continue;
      if ((ignore || []).some((one) => one === el || one.contains(el))) continue;
      // A single outer layer is the actionable part. Listing every nested div
      // produced dozens of misleading selections and could hide actual menus.
      found.add(el);
    }
  }
  // Every interceptor, the outer layer AND the ones inside it: an inner link can
  // switch clicks back on for itself, so none is dropped.
  return [...found];
}

function findHiddenLayers(skip) {
  const found = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ignore = skip || [];
  for (const node of document.body ? document.body.querySelectorAll('*') : []) {
    if (ignore.some((one) => one === node || one.contains(node))) continue;
    if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'HEAD'].includes(node.tagName)) continue;
    const cs = getComputedStyle(node);
    const already = node.hasAttribute('data-usr-clickthrough');
    if (cs.display === 'none' || cs.visibility === 'hidden' || (cs.pointerEvents === 'none' && !already)) continue;
    if (!['fixed', 'absolute', 'sticky'].includes(cs.position) && !already) continue;
    const r = node.getBoundingClientRect();
    if (r.width * r.height < 3000 || r.width < 30 || r.height < 20) continue;
    const clear = cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent';
    const invisible = Number(cs.opacity) < 0.05;
    if (!seemsInvisible(node, cs)) continue;
    if (isProtected(node)) continue;
    const clickable = node.tagName === 'A' || node.tagName === 'IFRAME' || node.hasAttribute('onclick') ||
      cs.cursor === 'pointer' || !!node.querySelector('a[href], iframe');
    const high = (parseInt(cs.zIndex, 10) || 0) >= 1000;
    const big = r.width * r.height >= vw * vh * 0.25;
    if (clickable || high || big) found.push(node);
    if (found.length >= 40) break;
  }
  // Everything found, outer layers and the ones inside them.
  return found;
}

// What is UNDER the pointer: the see-through layers above the first thing you can
// see there, whatever their size and whether or not a link lies beneath. Found when
// the mouse gets there, so layers made late, or only over a row of buttons, count too.
function invisibleAt(x, y, skip) {
  const out = [];
  for (const node of document.elementsFromPoint(x, y)) {
    if (skip && skip.some((one) => one === node || one.contains(node))) continue;
    if (node === document.body || node === document.documentElement) break;
    if (isProtected(node)) break;
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const placed = cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky';
    const content = /^(IMG|VIDEO|CANVAS|SVG|PICTURE|OBJECT|EMBED|INPUT|BUTTON|SELECT|TEXTAREA|AUDIO|IFRAME)$/i.test(node.tagName);
    const bare = !content && !node.querySelector('img, video, canvas, svg, picture, input, button, textarea, select, iframe') &&
      !(node.innerText || '').trim() && cs.backgroundImage === 'none' && cs.borderTopStyle === 'none';
    const see = Number(cs.opacity) < 0.05 ||
      (placed && (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent') && bare);
    if (placed && see) out.push(node);
    else if (Number(cs.opacity) >= 0.05 && !bare) break; // something you can see: stop here
  }
  return out;
}

// An EMPTY link (no text, picture or background) to another site that opens a new
// tab: what an ad network puts inside its see-through layer.
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

// The layers that hold such links, found from the link itself: the outermost
// positioned, see-through (or empty) box around it, and the link. Wherever the layer is,
// whatever it is called, however it looks.
function hijackLayers() {
  const out = new Set();
  for (const link of document.querySelectorAll('a[href][target]')) {
    if (!isHijackLink(link)) continue;
    let root = link;
    let node = link.parentElement;
    for (let i = 0; node && i < 7 && node !== document.body && node !== document.documentElement; i++, node = node.parentElement) {
      const cs = getComputedStyle(node);
      const placed = cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky';
      if (placed && (Number(cs.opacity) < 0.2 || !(node.innerText || '').trim())) root = node;
      else break;
    }
    out.add(root);
    out.add(link);
  }
  return [...out];
}

globalThis.UsrSelector = {hijackLayers, isHijackLink, invisibleAt, selectorFor, positionOnly, stableClass, stableId, findHiddenLayers,
  findInterceptors, isChallengePage};
})();
