import {log} from '/lib/util/log.js';
import {
  prepareScanTab,
  finishScanTab,
  readCaptureEnvironment,
  stampSnapshot,
} from './scan_environment.js';
import {MARK_HIDDEN_PARTS_JS} from './mark_hidden.js';

// Pacing of a capture. Slow ads can take around 6 seconds to load, and the old
// fast scroll did not give them time, so images looked "missing" and the page
// was moved to a deeper scan mode. The page is now swept three times, each a
// little slower than the last, and a capture aims for about 20 seconds.
const RENDER_WAIT_MS = 1000;           // pause once the page is ready, before the first sweep
const TAB_LOAD_TIMEOUT_MS = 30000;     // give up waiting for the page altogether
const LOAD_GRACE_MS = 2000;            // do not wait for a slow ad to finish the load event
const SWEEP_TARGET_MS = [4000, 5000, 6000]; // length of sweeps 1, 2 and 3 (top to bottom and back)
const SWEEP_UNSCROLLABLE_MS = 1500;    // a page with nothing to scroll only needs a short wait
const SWEEP_MIN_STEP_MS = 120;         // an extremely long page is never swept faster than this
const SWEEP_MAX_STEP_MS = 1200;
const SWEEP_BOTTOM_MS = 400;
const SWEEP_TOP_MS = 600;
const SETTLE_MS = 2000;                // final settle at the top before the capture
// If images are still missing after the three sweeps, try once more, slower,
// before the page is judged to need a deeper scan mode.
const SLOW_SWEEP_MS = 8000;

// A quick look, used only to check whether the faster Standard scan misses part
// of a page. It only reads the page (text and image addresses), so it does not
// build a saved snapshot or wait for pictures to finish: a pause for the page's
// scripts to fill things in, ONE sweep to wake up lazy content, and a short
// settle: about 6 seconds, and 10 at the very most.
const QUICK_RENDER_WAIT_MS = 2500;
const QUICK_SWEEP_MS = 2500;
const QUICK_SETTLE_MS = 1000;
const QUICK_MAX_TOTAL_MS = 10000; // the whole quick look, from opening the tab, never takes longer
const QUICK_READ_MS = 800;        // kept in reserve to read the page and close

/**
 * Fetch a page by opening it in a real browser tab, waiting for JavaScript
 * to render, then extracting the DOM with all CSS inlined as <style> tags.
 * This makes the HTML self-contained so CSS works when displayed in the
 * scanner viewer.
 */
export async function fetchRenderedHtml(url, options = {}) {
  const quick = options.quick === true;
  const startedAt = Date.now();
  log(`Fetching rendered HTML for: ${url}${quick ? ' (quick look)' : ''}`);

  const tab = await browser.tabs.create({
    url: url,
    active: false,
  });

  let zoomState = null;
  try {
    await waitForTabLoad(tab.id, TAB_LOAD_TIMEOUT_MS);
    // Scan at a steady zoom, whatever zoom the user has for this site.
    zoomState = await prepareScanTab(tab.id);
    const renderWait = quick ? QUICK_RENDER_WAIT_MS : RENDER_WAIT_MS;
    log(`Tab loaded, waiting ${renderWait}ms for JS rendering...`);
    await new Promise(resolve => setTimeout(resolve, renderWait));

    if (quick) {
      // One quick sweep wakes lazy content up; then just read the page.
      await scrollPageForImages(tab.id, {quick: true, endBy: startedAt + QUICK_MAX_TOTAL_MS});
      const [quickHtml] = await browser.tabs.executeScript(tab.id, {
        runAt: 'document_end',
        code: '(function () {' + MARK_HIDDEN_PARTS_JS + ' return document.documentElement.outerHTML; })()',
      });
      if (quickHtml) {
        log(`Quick look read the page (${quickHtml.length} chars)`);
        // Standard saves the plain HTML, which is shown without scripts. A site
        // that keeps its content hidden until scripts reveal it looks blank
        // that way even though the text is "there", so count what is actually
        // visible in the plain HTML and in the live page.
        if (options.standardHtml && options.report) {
          try {
            await browser.tabs.executeScript(tab.id, {
              runAt: 'document_end',
              code: '(' + startPlainFrame.toString() + ')(' +
                JSON.stringify(options.standardHtml) + ',' + JSON.stringify(url) + ')',
            });
            // Wait for it from here (not inside the throttled tab), but never
            // past the quick look's ceiling.
            const giveUp = Date.now() +
              Math.max(800, Math.min(2000, startedAt + QUICK_MAX_TOTAL_MS - Date.now()));
            let ready = false;
            while (!ready && Date.now() < giveUp) {
              const [state] = await browser.tabs.executeScript(tab.id, {
                runAt: 'document_end',
                code: '(function () { var f = document.getElementById("__uscan_plain_frame"); ' +
                  'return !!(f && f.getAttribute("data-loaded") === "1"); })()',
              });
              ready = state === true;
              if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
            }
            const [shown] = await browser.tabs.executeScript(tab.id, {
              runAt: 'document_end',
              code: '(' + measurePlainFrame.toString() + ')()',
            });
            if (shown && shown.error) log(`Plain HTML frame measure failed: ${shown.error}`);
            if (!shown) {
              log(`Plain HTML frame could not be measured (frame ${ready ? 'loaded' : 'not loaded'})`);
            }
            if (shown && !shown.error) {
              options.report.liveWords = shown.liveWords;
              options.report.plainWords = shown.plainWords;
              options.report.plainBottom = shown.plainBottom;
              options.report.plainTransparentWords = shown.plainTransparentWords;
              options.report.plainSkeletons = shown.plainSkeletons;
              options.report.viewport = shown.viewport;
              log(`Plain HTML frame: ${ready ? 'loaded' : 'NOT loaded in time'}; ` +
                `${shown.pending} of ${shown.sheets} stylesheets not applied`);
              log(`Visible words: live page ${shown.liveWords}, plain HTML shown without scripts ${shown.plainWords} ` +
                `(plus ${shown.plainTransparentWords} in invisible parts, ${shown.plainSkeletons} loading placeholders); ` +
                `plain content reaches ${shown.plainBottom}px of a ${shown.viewport}px window`);
            }
          } catch (error) {
            log(`Could not measure the plain HTML display: ${error}`);
          }
        }
        return quickHtml;
      }
    }

    // Diagnostic: sample only elements actually covering the current viewport.
    // This identifies large visual layers without walking/computing every DOM node.
    try {
      const [visualLayers] = await browser.tabs.executeScript(tab.id, {
        code: `(() => {
          const found = new Set();
          const vw = innerWidth;
          const vh = innerHeight;

          for (let x = vw * 0.1; x < vw; x += vw * 0.2) {
            for (let y = vh * 0.1; y < vh; y += vh * 0.15) {
              for (const hit of document.elementsFromPoint(x, y)) {
                let el = hit;
                for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
                  found.add(el);
                }
              }
            }
          }

          return [...found].map(el => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const before = getComputedStyle(el, "::before");
            const after = getComputedStyle(el, "::after");

            return {
              tag: el.tagName,
              id: el.id || "",
              cls: typeof el.className === "string" ? el.className.slice(0, 180) : "",
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
              bg: cs.backgroundImage || "none",
              beforeBg: before.backgroundImage || "none",
              afterBg: after.backgroundImage || "none",
              src: el.currentSrc || el.src || "",
              canvas: el.tagName === "CANVAS",
            };
          }).filter(x =>
            x.w >= 250 &&
            x.h >= 100 &&
            (
              x.bg !== "none" ||
              x.beforeBg !== "none" ||
              x.afterBg !== "none" ||
              x.src ||
              x.canvas
            )
          ).slice(0, 40);
        })()`,
      });

      log(`Live visual layers: ${JSON.stringify(visualLayers || [])}`);
      try {
        const [imageSourceDiagnostic] = await browser.tabs.executeScript(tab.id, {
          code: `(() => {
            const rows = [];
            const seen = new Set();
            const add = (el, kind) => {
              const r = el.getBoundingClientRect();
              if (r.width < 80 || r.height < 60) return;
              if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return;
              const cs = getComputedStyle(el);
              const row = {
                kind,
                tag: el.tagName,
                x: Math.round(r.x), y: Math.round(r.y),
                w: Math.round(r.width), h: Math.round(r.height),
                src: el.getAttribute("src") || "",
                currentSrc: el.currentSrc || "",
                srcset: el.getAttribute("srcset") || "",
                dataSrc: el.getAttribute("data-src") || "",
                dataLazySrc: el.getAttribute("data-lazy-src") || "",
                dataOriginal: el.getAttribute("data-original") || "",
                dataSrcset: el.getAttribute("data-srcset") || "",
                bg: cs.backgroundImage || "none"
              };
              const key = JSON.stringify(row);
              if (!seen.has(key)) { seen.add(key); rows.push(row); }
            };
            document.querySelectorAll("img").forEach(el => add(el, "img"));
            document.querySelectorAll("picture").forEach(el => add(el, "picture"));
            document.querySelectorAll("source").forEach(el => {
              const p = el.parentElement;
              if (p) add(p, "source-parent");
            });
            document.querySelectorAll("*").forEach(el => {
              const bg = getComputedStyle(el).backgroundImage;
              if (bg && bg !== "none") add(el, "background");
            });
            return rows.slice(0, 120);
          })()`,
        });
        log(`IMAGE SOURCE DIAGNOSTIC: ${JSON.stringify(imageSourceDiagnostic || [])}`);
      } catch (e) {
        log(`IMAGE SOURCE DIAGNOSTIC failed: ${e}`);
      }

    } catch (e) {
      log(`Live visual-layer diagnostic failed: ${e}`);
    }

    // Walk through the page so viewport-triggered content gets loaded.
    await scrollPageForImages(tab.id, {quick});
    try {
      const [absoluteLayoutState] = await browser.tabs.executeScript(tab.id, {
        code: `(() => {
          const rows = [...document.querySelectorAll('*']].map((el, i) => {
            const cs = getComputedStyle(el);
            if (cs.position !== 'absolute') return null;
            const r = el.getBoundingClientRect();
            if (r.width < 150 || r.height < 100) return null;
            return {
              i,
              tag: el.tagName,
              cls: typeof el.className === 'string' ? el.className : '',
              x: Math.round(r.x), y: Math.round(r.y),
              w: Math.round(r.width), h: Math.round(r.height),
              computedTop: cs.top,
              computedLeft: cs.left,
              computedTransform: cs.transform,
              computedWidth: cs.width,
              computedHeight: cs.height,
              inlineStyle: el.getAttribute('style') || '',
              animations: typeof el.getAnimations === 'function' ? el.getAnimations().map(a => {
                return {
                  playState: a.playState,
                  currentTime: a.currentTime,
                  playbackRate: a.playbackRate,
                  pending: a.pending,
                };
              }) : [],
            };
          }).filter(Boolean);
          return rows;
        })()`,
      });
      log(`ABSOLUTE LAYOUT STATE JSON: ${JSON.stringify(absoluteLayoutState)}`);
    } catch (e) {
      log(`ABSOLUTE LAYOUT STATE DIAGNOSTIC FAILED: ${e}`);
    }


    try {
      const [mainCardLayout] = await browser.tabs.executeScript(tab.id, {
        code: `(() => {
          const img = [...document.images].find(x => {
            const r = x.getBoundingClientRect();
            return x.naturalWidth > 0 &&
              r.width >= 200 && r.width <= 300 &&
              r.height >= 120 && r.height <= 400 &&
              /t\.vndb\.org\//.test(x.currentSrc || x.src || "");
          });
          if (!img) return null;
          const chain = [];
          let n = img;
          for (let depth = 0; n && depth < 7; depth++, n = n.parentElement) {
            const cs = getComputedStyle(n);
            const r = n.getBoundingClientRect();
            chain.push({
              depth,
              tag: n.tagName,
              cls: typeof n.className === "string" ? n.className : "",
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
              display: cs.display,
              position: cs.position,
              top: cs.top,
              left: cs.left,
              right: cs.right,
              bottom: cs.bottom,
              zIndex: cs.zIndex,
              transform: cs.transform,
              overflow: cs.overflow,
              opacity: cs.opacity
            });
          }
          return {src: img.currentSrc || img.src || "", chain};
        })()`,
      });
      log(`LIVE MAIN CARD LAYOUT: ${JSON.stringify(mainCardLayout)}`);
    } catch (e) {
      log(`LIVE MAIN CARD LAYOUT failed: ${e}`);
    }



    // Inline all CSS from document.styleSheets into <style> tags,
    // and convert relative URLs to absolute so everything resolves.
    const results = await browser.tabs.executeScript(tab.id, {
      code:
        '(function(pageUrl) {' +
          // 1. Inline each readable linked stylesheet in its original DOM position.
          // Preserve cascade order instead of merging all rules at the end of <head>.
          '  var sheets = Array.prototype.slice.call(document.styleSheets);' +
          '  for (var i = 0; i < sheets.length; i++) {' +
          '    var sheet = sheets[i];' +
          '    var owner = sheet.ownerNode;' +
          '    if (!owner || owner.tagName !== "LINK") continue;' +
          '    try {' +
          '      var rules = sheet.cssRules || sheet.rules;' +
          '      var cssText = [];' +
          '      for (var j = 0; j < rules.length; j++) cssText.push(rules[j].cssText);' +
          '      var style = document.createElement("style");' +
          '      style.textContent = cssText.join("\\n");' +
          '      if (owner.media) style.media = owner.media;' +
          '      if (owner.title) style.title = owner.title;' +
          '      style.disabled = !!sheet.disabled;' +
          '      style.setAttribute("data-updatescan-inline-stylesheet", sheet.href || owner.href || "");' +
          '      owner.parentNode.replaceChild(style, owner);' +
          '    } catch(e) {}' +
          '  }' +
        // Freeze large images that Firefox is actually painting in the viewport.
        // This preserves runtime carousel/slider visuals without touching icons,
        // thumbnails, hidden slides, or other small UI assets.
        '  document.querySelectorAll("img").forEach(function(img) {\n    try {\n      var resolved = img.currentSrc || img.src || "";\n      if (resolved) img.setAttribute("data-updatescan-resolved-src", resolved);\n    } catch(e) {}\n  });\n  window.__updatescanPaintedFreeze = [];' +
        '  document.querySelectorAll("img").forEach(function(img) {' +
        '    try {' +
        '      if (!img.complete || !img.naturalWidth) return;' +
        '      var r = img.getBoundingClientRect();' +
        '      if (r.width < 400 || r.height < 200) return;' +
        '      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return;' +
        '      var pts = [[0.5,0.5],[0.25,0.25],[0.75,0.25],[0.25,0.75],[0.75,0.75]];' +
        '      var hits = 0;' +
        '      for (var pi = 0; pi < pts.length; pi++) {' +
        '        var x = r.left + r.width * pts[pi][0];' +
        '        var y = r.top + r.height * pts[pi][1];' +
        '        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;' +
        '        if (document.elementsFromPoint(x, y).indexOf(img) !== -1) hits++;' +
        '      }' +
        '      if (hits < 3) return;' +
        '      window.__updatescanPaintedFreeze.push({src:img.currentSrc||img.src||"",x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),hits:hits});' +
        '      var canvas = document.createElement("canvas");' +
        '      canvas.width = img.naturalWidth;' +
        '      canvas.height = img.naturalHeight;' +
        '      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);' +
        '      var data = canvas.toDataURL("image/png");' +
        '      if (!img.hasAttribute("data-updatescan-original-src")) img.setAttribute("data-updatescan-original-src", img.currentSrc || img.src || "");' +
        '      if (img.hasAttribute("srcset") && !img.hasAttribute("data-updatescan-original-srcset")) img.setAttribute("data-updatescan-original-srcset", img.getAttribute("srcset") || "");' +
        '      img.removeAttribute("srcset");' +
        '      img.setAttribute("src", data);' +
        '      img.setAttribute("data-updatescan-painted-freeze", "1");' +
        '    } catch(e) {}' +
        '  });' +
        '  console.log("UPDATESCAN_PAINTED_FREEZE", JSON.stringify(window.__updatescanPaintedFreeze));' +
        // Snapshot the loaded page's header logo. srcdoc may be blocked from
        // requesting this image even when a normal Firefox tab loaded it.
        '  document.querySelectorAll("header .logo img[src]").forEach(function(img) {' +
        '    if (!img.complete || !img.naturalWidth) return;' +
        '    try {' +
        '      var canvas = document.createElement("canvas");' +
        '      canvas.width = img.naturalWidth;' +
        '      canvas.height = img.naturalHeight;' +
        '      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);' +
        '      var data = canvas.toDataURL("image/png");' +
        '      img.setAttribute("data-updatescan-original-src", img.src);' +
        '      img.setAttribute("src", data);' +
        '    } catch(e) {}' + // tainted cross-origin canvas: retain original
        '  });' +
        // 3. Add base tag for any remaining relative URLs
        '  var base = document.querySelector("base") || document.createElement("base");' +
        '  base.href = pageUrl.replace(/[^/]*([?#].*)?$/, "");' +
        '  if (!document.querySelector("base")) document.head.insertBefore(base, document.head.firstChild);' +
        // 4. Convert relative src/href to absolute
        '  document.querySelectorAll("[src],[href]").forEach(function(el) {' +
        '    ["src","href"].forEach(function(a) {' +
        '      var v = el.getAttribute(a);' +
        '      if (v && !v.match(/^(https?:|data:|blob:|#|javascript:)/)) {' +
        '        try { el.setAttribute(a, new URL(v, pageUrl).href); } catch(e) {}' +
        '      }' +
        '    });' +
        '  });' +
        // Normalize invalid nested anchors before HTML serialization. Live JS DOMs can contain <a> inside <a>, but reparsing outerHTML splits the outer card and destroys its visual structure.
        '  Array.prototype.slice.call(document.querySelectorAll("a a")).forEach(function(inner) { var span=document.createElement("span"); Array.prototype.slice.call(inner.attributes).forEach(function(attr) { if (attr.name !== "href" && attr.name !== "target" && attr.name !== "rel") span.setAttribute(attr.name, attr.value); }); var href=inner.getAttribute("href"); if (href) span.setAttribute("data-updatescan-original-href", href); while (inner.firstChild) span.appendChild(inner.firstChild); inner.parentNode.replaceChild(span, inner); });' +
        // Mark what is not showing (hidden carousel slides, closed menus ...)
        // so only what is on the page counts when comparing.
        MARK_HIDDEN_PARTS_JS +
        '  return document.documentElement.outerHTML;' +
        '})(' + JSON.stringify(url) + ')',
    });

    if (results && results[0]) {
      const freezeDoc = new DOMParser().parseFromString(results[0], "text/html");
      const frozen = [...freezeDoc.querySelectorAll('img[data-updatescan-painted-freeze="1"]')];
      log(`Painted freeze result: count=${frozen.length}; images=${JSON.stringify(frozen.map(img => img.getAttribute("data-updatescan-original-src") || "").slice(0, 12))}`);

      // The page context cannot read cross-origin CSS rules. Fetch those sheets
      // from the extension context before saving the snapshot as a srcdoc page.
      let html = results[0];
      html = await inlineSnapshotImages(html, url, tab.id);
      // Record the zoom and window size this capture was taken at.
      html = stampSnapshot(html, await readCaptureEnvironment(tab.id, zoomState));
      log(`Rendered HTML extracted with embedded images (${html.length} chars)`);
      return html;
    }
    throw new Error('No HTML content extracted from rendered page');
  } finally {
    await finishScanTab(tab.id, zoomState);
    try {
        await browser.tabs.remove(tab.id);
      log(`Rendered tab cleanup succeeded: id=${tab.id}`);
    } catch (e) {
      log(`Rendered tab cleanup FAILED: id=${tab.id}; error=${e}`);
    }
  }
}

/**
 * Runs inside the scan tab. Starts showing the plain Standard HTML the way the
 * viewer shows it: in a frame with scripts switched off. Loading it takes a
 * moment, so measurePlainFrame() is called separately once it is ready (the
 * waiting is done by the extension, because timers inside a background tab are
 * slowed down to one tick a second).
 *
 * @param {string} plainHtml - The HTML the Standard scan saved.
 * @param {string} pageUrl - Page address, for relative links in that HTML.
 */
function startPlainFrame(plainHtml, pageUrl) {
  const frame = document.createElement('iframe');
  frame.id = '__uscan_plain_frame';
  frame.setAttribute('sandbox', 'allow-same-origin'); // no scripts, like the viewer
  // A fixed desktop-size frame, so the answer does not depend on how big the
  // scan window happens to be (a narrow window triggers "mobile" style rules
  // that can show content a desktop visitor would not see).
  frame.style.cssText = 'position:fixed;left:0;top:0;border:0;opacity:0;pointer-events:none;' +
    'width:1100px;height:800px';
  const base = '<base href="' + pageUrl.replace(/"/g, '&quot;') + '">';
  frame.srcdoc = /<head[^>]*>/i.test(plainHtml) ?
    plainHtml.replace(/<head[^>]*>/i, (m) => m + base) : base + plainHtml;
  frame.addEventListener('load', () => frame.setAttribute('data-loaded', '1'));
  document.body.appendChild(frame);
  return true;
}

/**
 * Runs inside the scan tab once the plain frame has loaded. Counts the words
 * that are really visible (not display:none, visibility:hidden or fully
 * transparent, and with a box) in the live page and in the plain HTML.
 *
 * @returns {object} Word counts and layout facts for the live page and the
 * plain HTML, or null if the frame is missing.
 */
function measurePlainFrame() {
  try {
    return measure();
  } catch (e) {
    return {error: String(e && e.stack || e)};
  }
  function measure() {
  const frame = document.getElementById('__uscan_plain_frame');
  if (!frame || !frame.contentDocument || !frame.contentDocument.body) return null;

  const visibleWords = (doc) => {
    const win = doc.defaultView;
    const memo = new Map();
    // 'ok' = showing, 'transparent' = in the page but invisible (opacity 0 or
    // visibility hidden: the usual "revealed later by a script"), 'gone' =
    // display:none (menus, dialogs: ignored).
    const state = (el) => {
      if (!el || el === doc.documentElement) return 'ok';
      if (memo.has(el)) return memo.get(el);
      const cs = win.getComputedStyle(el);
      const up = state(el.parentElement);
      let result;
      if (cs.display === 'none' || up === 'gone') result = 'gone';
      else if (up === 'transparent' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) result = 'transparent';
      else result = 'ok';
      memo.set(el, result);
      return result;
    };
    let count = 0;
    let transparent = 0;
    let bottom = 0; // how far down the visible content reaches
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      if (text.length < 3) continue;
      const el = node.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName)) continue;
      const shown = state(el);
      if (shown === 'gone') continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const words = (text.match(/[A-Za-z0-9]{3,}/g) || []).length;
      if (shown === 'transparent') { transparent += words; continue; }
      count += words;
      bottom = Math.max(bottom, box.bottom);
    }
    for (const el of doc.querySelectorAll('img, video, canvas, svg')) {
      if (state(el) !== 'ok') continue;
      const box = el.getBoundingClientRect();
      if (box.width >= 20 && box.height >= 20) bottom = Math.max(bottom, box.bottom);
    }
    return {count, bottom, transparent};
  };
  // A scan tab is a background tab, where the browser freezes fade-in
  // animations and transitions at their starting value, so a reveal that has
  // been triggered still looks transparent. Jump them to their end state, as a
  // visitor (or the viewer) would see them.
  const settle = (doc) => {
    try {
      for (const animation of doc.getAnimations()) {
        try { animation.finish(); } catch (e) { /* endless animation: leave it */ }
      }
    } catch (e) { /* not supported: count as it is */ }
  };

  settle(document);
  const liveWords = visibleWords(document).count;

  const doc = frame.contentDocument;
  const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'));
  const sheets = links.length;
  const pending = links.filter((link) => !link.sheet).length; // not applied (yet)

  // Loading placeholders: empty boxes that pulse or shimmer for ever (or are
  // named skeleton/shimmer). Only noted for the log.
  const placeholders = new Set();
  const emptyBox = (el) => {
    if (!el || el.nodeType !== 1 || (el.textContent || '').trim()) return false;
    const box = el.getBoundingClientRect();
    return box.width >= 8 && box.height >= 6;
  };
  try {
    for (const animation of doc.getAnimations()) {
      try {
        const timing = animation.effect && animation.effect.getComputedTiming();
        const target = animation.effect && animation.effect.target;
        if (timing && timing.iterations === Infinity && emptyBox(target)) placeholders.add(target);
      } catch (e) { /* skip this one */ }
    }
  } catch (e) { /* not supported */ }
  for (const el of doc.querySelectorAll('[class*="skeleton" i], [class*="shimmer" i]')) {
    if (emptyBox(el)) placeholders.add(el);
  }
  const plainSkeletons = placeholders.size;

  settle(doc);
  const plain = visibleWords(doc);
  frame.remove();
  return {
    liveWords, plainWords: plain.count, plainTransparentWords: plain.transparent,
    plainBottom: Math.round(plain.bottom), viewport: 800,
    sheets, pending, plainSkeletons,
  };
  }
}

/**
 * Wait until the page is ready to capture: normally when the load event has
 * finished, but not for ever. Slow ads and trackers can hold the load event
 * back for 20+ seconds, so once the page itself is ready (DOM built) it only
 * waits LOAD_GRACE_MS more.
 */
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let readySince = null;
    let finished = false;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      browser.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error); else resolve();
    };

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    }
    browser.tabs.onUpdated.addListener(onUpdated);

    const poll = setInterval(async () => {
      if (finished) return;
      if (Date.now() - started > timeoutMs) {
        finish(new Error('Tab load timed out'));
        return;
      }
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.status === 'complete') { finish(); return; }
        const [state] = await browser.tabs.executeScript(tabId, {runAt: 'document_start', code: 'document.readyState'});
        if (state === 'interactive' || state === 'complete') {
          if (readySince === null) readySince = Date.now();
          if (Date.now() - readySince >= LOAD_GRACE_MS) {
            log(`Page is ready but a slow resource is still loading; not waiting for it (${Math.round((Date.now() - started) / 100) / 10}s)`);
            finish();
          }
        }
      } catch (e) { /* the page is not scriptable yet */ }
    }, 250);

    browser.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') finish();
    }).catch(() => {});
  });
}
/** Inline links left behind by cssRules SecurityError. Preserve them if fetch fails. */
export async function inlineRemainingStylesheets(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const links = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')];
  for (const link of links) {
    try {
      const cssUrl = new URL(link.getAttribute('href'), pageUrl).href;
      const response = await fetch(cssUrl);
      if (!response.ok) continue;
      const css = await response.text();
      const style = doc.createElement('style');
      // CSS url() paths must still resolve against the original stylesheet.
      style.textContent = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
        (match, quote, path) => {
          try { return `url("${new URL(path.trim(), cssUrl).href}")`; }
          catch (e) { return match; }
        });
      link.replaceWith(style);
    } catch (e) {
      // Keep the original link instead of silently dropping the stylesheet.
    }
  }
  return doc.documentElement.outerHTML;
}

/** Trigger lazy images in a background tab before serializing its DOM. */
async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Embed externally loaded images into the stored snapshot so srcdoc does not
 * have to request them again. Preserve their real URL for later image diffing.
 */
export async function inlineSnapshotImages(html, pageUrl, tabId = null) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = [...doc.querySelectorAll("img[src]")];
  const entries = [];
  const uniqueUrls = [];
  const seenUrls = new Set();
  const dataUrlCache = new Map();
  let embedded = 0;
  let failed = 0;

  for (const img of images) {
    const src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:")) continue;
    const resolvedSrc = img.getAttribute("data-updatescan-resolved-src") || src;

    let imageUrl;
    try {
      imageUrl = new URL(resolvedSrc, pageUrl).href;
    } catch (e) {
      failed++;
      continue;
    }

    entries.push({img, imageUrl});
    if (!seenUrls.has(imageUrl)) {
      seenUrls.add(imageUrl);
      uniqueUrls.push(imageUrl);
    }
  }

  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= uniqueUrls.length) return;
      const imageUrl = uniqueUrls[index];
      try {
        const response = await fetch(imageUrl, {
          credentials: "include",
          cache: "force-cache",
        });
        if (!response.ok) {
          dataUrlCache.set(imageUrl, null);
          continue;
        }
        const blob = await response.blob();
        dataUrlCache.set(imageUrl, await blobToDataUrl(blob));
      } catch (e) {
        dataUrlCache.set(imageUrl, null);
      }
    }
  };

  const workerCount = Math.min(8, uniqueUrls.length);
  await Promise.all(Array.from({length: workerCount}, () => worker()));


  // UPDATESCAN_LOADED_IMAGE_FALLBACK_V1
  // Capture only images whose extension-context fetch failed.
  if (tabId != null) {
    const missingUrls = uniqueUrls.filter(url => !dataUrlCache.get(url));
    if (missingUrls.length) {
      try {
        const [capture] = await browser.tabs.executeScript(tabId, {
          code: '(' + async function(urls) {
            const wanted = new Set(urls);
            const captured = new Map();
            const errors = [];
            const toDataUrl = blob => new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            for (const img of document.images) {
              const url = img.currentSrc || img.src || "";
              if (!wanted.has(url) || captured.has(url)) continue;
              if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue;
              // First choice: the picture's own file, fetched the way the page
              // fetches it (same cookies, so a site that turns scripted
              // downloads away still hands it over). That keeps the exact
              // original picture at its full size, and it is smaller than a
              // copy drawn through a canvas.
              try {
                const response = await fetch(url, {credentials: "include", cache: "force-cache"});
                if (response.ok) {
                  const blob = await response.blob();
                  if (blob.size > 0 && blob.size < 8000000 && /^image\//.test(blob.type)) {
                    captured.set(url, await toDataUrl(blob));
                    continue;
                  }
                }
              } catch (error) { /* fall back to drawing it through a canvas */ }
              try {
                if (img.naturalWidth * img.naturalHeight > 16777216) {
                  throw new Error("Image exceeds capture size limit");
                }
                const canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const context = canvas.getContext("2d");
                if (!context) throw new Error("Canvas context unavailable");
                context.drawImage(img, 0, 0, canvas.width, canvas.height);
                const data = canvas.toDataURL("image/png");
                if (!data.startsWith("data:image/png")) {
                  throw new Error("Canvas returned no image");
                }
                captured.set(url, data);
              } catch (error) {
                errors.push({url, error: String(error)});
              }
            }
            return {images: Array.from(captured), errors};
          }.toString() + ')(' + JSON.stringify(missingUrls) + ')',
        });
        for (const [url, data] of (capture && capture.images) || []) {
          dataUrlCache.set(url, data);
        }
        log(`LOADED IMAGE FALLBACK: requested=${missingUrls.length}; captured=${((capture && capture.images) || []).length}; errors=${JSON.stringify((capture && capture.errors) || [])}`);
      } catch (error) {
        log(`LOADED IMAGE FALLBACK failed: ${error}`);
      }
    }
  }

  for (const {img, imageUrl} of entries) {
    const dataUrl = dataUrlCache.get(imageUrl);
    if (!dataUrl) {
      failed++;
      continue;
    }

    if (!img.hasAttribute("data-updatescan-original-src")) {
      img.setAttribute("data-updatescan-original-src", imageUrl);
    }
    if (img.hasAttribute("srcset")) {
      img.setAttribute(
        "data-updatescan-original-srcset",
        img.getAttribute("srcset"),
      );
      img.removeAttribute("srcset");
    }
    const picture = img.closest("picture");
    if (picture) {
      for (const source of picture.querySelectorAll("source[srcset]")) {
        if (!source.hasAttribute("data-updatescan-original-srcset")) {
          source.setAttribute("data-updatescan-original-srcset", source.getAttribute("srcset"));
        }
        source.removeAttribute("srcset");
      }
    }
    img.setAttribute("src", dataUrl);
    embedded++;
  }

  log(
    `Snapshot images embedded: ${embedded}/${images.length}; ` +
    `uniqueExternal=${uniqueUrls.length}; concurrency=${workerCount}; failed=${failed}`,
  );
  return doc.documentElement.outerHTML;
}

/**
 * One sweep of the page: top to bottom and back to the top, taking about
 * targetMs in total, so lazy images and slow ads have time to load.
 * A very long page is swept at the fastest pace allowed instead.
 *
 * @param {number} tabId - Tab to scroll.
 * @param {string} label - Name of the sweep (for the log).
 * @param {number} targetMs - How long the sweep should take.
 * @param {boolean} waitEvenIfShort - Wait the full time even if the page has
 * nothing to scroll (slow ads load with time, not with scrolling).
 *
 * @returns {Promise<boolean>} False if the page could not be measured.
 */
async function sweepPage(tabId, label, targetMs, waitEvenIfShort = false, endBy = null) {
  const outOfTime = () => endBy !== null && Date.now() > endBy - QUICK_READ_MS;
  // runAt "document_end": scripts run once the DOM is built, not after the
  // load event, which a slow ad can hold back for a long time.
  const [size] = await browser.tabs.executeScript(tabId, {
    runAt: 'document_end',
    code: '({height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), viewport: innerHeight})',
  });
  if (!size || !size.viewport) return false;

  const step = Math.max(250, Math.floor(size.viewport * 0.8));
  const maxY = Math.max(0, size.height - size.viewport);
  const positions = [];
  for (let y = 0; y < maxY; y += step) positions.push(y);

  if (!positions.length) {
    const idle = waitEvenIfShort ? targetMs : Math.min(targetMs, SWEEP_UNSCROLLABLE_MS);
    log(`Rendered scroll pass ${label}: height=${size.height}, nothing to scroll; waiting ${idle}ms`);
    await new Promise(resolve => setTimeout(resolve, idle));
    return true;
  }

  const tail = SWEEP_BOTTOM_MS + SWEEP_TOP_MS;
  const perStep = Math.min(SWEEP_MAX_STEP_MS,
    Math.max(SWEEP_MIN_STEP_MS, (targetMs - tail) / positions.length));
  log(`Rendered scroll pass ${label}: height=${size.height}, maxY=${maxY}, ` +
    `${positions.length} steps of ${Math.round(perStep)}ms (about ${Math.round((perStep * positions.length + tail) / 100) / 10}s)`);

  const started = Date.now();
  for (let i = 0; i < positions.length; i++) {
    if (outOfTime()) {
      log(`Rendered scroll pass ${label}: out of time at step ${i}/${positions.length}`);
      return true;
    }
    await browser.tabs.executeScript(tabId, {runAt: 'document_end', code: `scrollTo(0, ${positions[i]})`});
    // Keep to the schedule even though each scroll call takes a little time.
    const wait = started + (i + 1) * perStep - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  }
  await browser.tabs.executeScript(tabId, {runAt: 'document_end', code: `scrollTo(0, ${maxY})`});
  if (endBy !== null) return true;
  await new Promise(resolve => setTimeout(resolve, SWEEP_BOTTOM_MS));
  await browser.tabs.executeScript(tabId, {runAt: 'document_end', code: 'scrollTo(0, 0)'});
  await new Promise(resolve => setTimeout(resolve, SWEEP_TOP_MS));
  return true;
}

/**
 * Are all the page's images loaded, with no lazy-load placeholders left? Used
 * after the second sweep: when everything has already arrived, a third sweep
 * is not needed.
 *
 * @param {number} tabId - Tab being scanned.
 *
 * @returns {Promise<boolean>} True if nothing is missing.
 */
async function imagesAllLoaded(tabId) {
  try {
    const [state] = await browser.tabs.executeScript(tabId, {
      runAt: 'document_end',
      code: '(() => { const imgs = [...document.images]; imgs.forEach(img => { try { img.loading = "eager"; } catch (e) {} }); ' +
        'const missing = imgs.filter(img => !(img.complete && img.naturalWidth > 0) && (img.currentSrc || img.src)).length; ' +
        'const placeholders = [...document.querySelectorAll("[class*=\\"lazy-load-image\\"], [data-src], [data-lazy-src], [data-original]")].filter(el => { ' +
        'if (el.tagName === "IMG" || el.querySelector("img")) return false; const r = el.getBoundingClientRect(); return r.width >= 40 && r.height >= 40; }).length; ' +
        'return {total: imgs.length, missing, placeholders}; })()',
    });
    log(`Images after the second sweep: ${state ? `${state.total - state.missing}/${state.total} loaded, ${state.placeholders} placeholders` : 'unknown'}`);
    return !!state && state.missing === 0 && state.placeholders === 0;
  } catch (error) {
    return false;
  }
}

export async function scrollPageForImages(tabId, options = {}) {
  const quick = options.quick === true;
  const endBy = options.endBy || null;
  try {
    // Slow, steady sweeps: each one a little slower than the last, so lazy
    // images and slow-loading ads all get time to arrive.
    const sweeps = quick ? [QUICK_SWEEP_MS] : SWEEP_TARGET_MS;
    for (let pass = 1; pass <= sweeps.length; pass++) {
      if (pass === 3 && !quick && await imagesAllLoaded(tabId)) {
        log('All images were loaded after the second sweep; the third sweep is not needed');
        break;
      }
      if (!await sweepPage(tabId, `${pass}/${sweeps.length}`, sweeps[pass - 1], false, endBy)) return false;
    }
    if (quick) {
      await browser.tabs.executeScript(tabId, {runAt: 'document_end', code: 'scrollTo(0, 0)'});
      const spare = endBy ? endBy - Date.now() - QUICK_READ_MS : QUICK_SETTLE_MS;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(QUICK_SETTLE_MS, spare))));
      return true;
    }


    // The quick look skips the image-readiness passes and the slower retry.
    if (!quick) {
      // UPDATESCAN_GENERIC_EMPTY_IMAGE_CONTAINERS_V1
      const [containerReadiness] = await browser.tabs.executeScript(tabId, {
        code: '(' + async function() {
          const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
          const original = {x: window.scrollX, y: window.scrollY};
          const started = Date.now();
          const budget = 24000;
          function candidates() {
            return [...document.querySelectorAll('a[href]')].filter(link => {
              const rect = link.getBoundingClientRect();
              if (rect.width < 80 || rect.height < 60 ||
                  link.querySelector('img')) return false;
              let card = link;
              for (let depth = 0; depth < 4 && card.parentElement; depth++) {
                const peers = [...card.parentElement.children];
                if (peers.some(peer => {
                  if (peer === card || peer.tagName !== card.tagName ||
                      peer.className !== card.className) return false;
                  return [...peer.querySelectorAll('img')].some(img => {
                    const size = img.getBoundingClientRect();
                    return size.width >= 40 && size.height >= 40;
                  });
                })) return true;
                card = card.parentElement;
              }
              return false;
            });
          }
          const initial = candidates().length;
          let visited = 0;
          let passes = 0;
          try {
            for (let pass = 0; pass < 2; pass++) {
              const targets = candidates();
              if (!targets.length || Date.now() - started >= budget) break;
              passes++;
              for (const target of targets) {
                if (Date.now() - started >= budget) break;
                if (!target.isConnected || target.querySelector('img')) continue;
                target.scrollIntoView({
                  block: 'center', inline: 'nearest', behavior: 'auto'
                });
                window.dispatchEvent(new Event('scroll'));
                visited++;
                for (let check = 0; check < 5; check++) {
                  if (Date.now() - started >= budget) break;
                  await pause(150);
                  if (target.querySelector('img')) break;
                }
              }
              await pause(350);
            }
            return {
              initial,
              remaining: candidates().length,
              images: document.images.length,
              visited,
              passes,
              elapsedMs: Date.now() - started
            };
          } finally {
            window.scrollTo(original.x, original.y);
            if (passes) await pause(250);
          }
        }.toString() + ')()'
      });
      log(`GENERIC IMAGE CONTAINER READINESS: ${JSON.stringify(containerReadiness)}`);

      // UPDATESCAN_GENERIC_IMAGE_READINESS_V1
      const [readiness] = await browser.tabs.executeScript(tabId, {
        code: '(' + async function() {
          const original = {x: scrollX, y: scrollY};
          const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
          const inspect = () => {
            const imgs = Array.from(document.images);
            const placeholders = Array.from(document.querySelectorAll(
              '[class*="lazy"], [data-src], [data-lazy-src], [data-original]'
            )).filter(el => {
              if (el.tagName === "IMG" || el.querySelector("img")) return false;
              const r = el.getBoundingClientRect();
              if (r.width < 40 || r.height < 40) return false;
              const cls = String(el.className);
              return cls.includes("lazy-load-image") ||
                el.hasAttribute("data-src") || el.hasAttribute("data-lazy-src") ||
                el.hasAttribute("data-original");
            }).filter(el => !Array.from(el.children).some(child =>
              child.matches('[class*="lazy"], [data-src], [data-lazy-src], [data-original]')
            ));
            imgs.forEach(img => { img.loading = "eager"; });
            return {
              total: imgs.length,
              loaded: imgs.filter(img => img.complete && img.naturalWidth > 0).length,
              placeholders: placeholders.length,
              signature: imgs.map(img => img.currentSrc || img.src || "").join("|"),
              targets: placeholders.concat(imgs.filter(img =>
                !img.complete || !img.naturalWidth
              ))
            };
          };
          let previous = "", stable = 0, result;
          const ready = state => {
            const signature = JSON.stringify([
              state.total, state.loaded, state.placeholders, state.signature
            ]);
            stable = signature === previous ? stable + 1 : 0;
            previous = signature;
            return state.loaded === state.total &&
              state.placeholders === 0 && stable >= 2;
          };
          let extraPass = false;
          // Give up as soon as nothing is changing, and never wait longer than
          // this in total. Images that will never load (ads, trackers) used to
          // keep this running for 40+ seconds in a background tab.
          const deadline = Date.now() + 3000;
          try {
            for (let check = 0; check < 2; check++) {
              result = inspect();
              if (ready(result) || stable >= 2 ||
                  (result.loaded === result.total && result.placeholders === 0)) break;
              await pause(400);
            }
            const finished = result.loaded === result.total &&
              result.placeholders === 0;
            // Stalled: the same images are still unloaded and there is nothing
            // left that a scroll could trigger, so another pass would not help.
            const stalled = result.placeholders === 0 && stable >= 2;
            // The slower fourth sweep (run afterwards, only if needed) does this job.
            const allowExtraPass = false;
            if (allowExtraPass && !finished && !stalled) {
              extraPass = true;
              const step = Math.max(250, Math.floor(innerHeight * 0.8));
              const maxY = Math.max(0,
                Math.max(document.documentElement.scrollHeight,
                         document.body.scrollHeight) - innerHeight);
              for (let y = 0; y < maxY; y += step) {
                if (Date.now() > deadline) break;
                scrollTo(0, y);
                window.dispatchEvent(new Event("scroll"));
                await pause(200);
              }
              scrollTo(0, maxY);
              await pause(350);
              scrollTo(0, 0);
              previous = "";
              stable = 0;
              for (let check = 0; check < 6; check++) {
                result = inspect();
                if (ready(result) || stable >= 2 || Date.now() > deadline) break;
                if (result.targets.length) {
                  result.targets[check % result.targets.length].scrollIntoView({
                    block: "center", inline: "nearest", behavior: "auto"
                  });
                  window.dispatchEvent(new Event("scroll"));
                }
                await pause(400);
              }
            }
            result = inspect();
            return {
              total: result.total, loaded: result.loaded,
              placeholders: result.placeholders, extraPass,
              settled: result.loaded === result.total &&
                result.placeholders === 0 && stable >= 2
            };
          } finally {
            scrollTo(original.x, original.y);
            if (extraPass) await pause(250);
          }
        }.toString() + ')()'
      });
      log(`GENERIC IMAGE READINESS: ${JSON.stringify(readiness)}`);

      // Images still missing after the three sweeps? Slow ads can take a while,
      // so sweep once more, slower, and settle before giving up. Only if images
      // are still missing after that does the page move to a deeper scan mode.
      const countMissingImages = async () => {
        const [gap] = await browser.tabs.executeScript(tabId, {
          runAt: 'document_end',
          code: '(() => { const imgs = [...document.images]; let missing = 0; for (const img of imgs) { if (img.complete && img.naturalWidth > 0) continue; const r = img.getBoundingClientRect(); if (r.width > 0 && r.height > 0) missing++; } return {total: imgs.length, missing}; })()',
        });
        return gap || {total: 0, missing: 0};
      };
      const gap = await countMissingImages();
      if ((gap.missing > 0 || (readiness && readiness.placeholders > 0)) && !quick) {
        log(`Rendered images still missing: ${gap.missing}/${gap.total}; one slower sweep (${SLOW_SWEEP_MS / 1000}s) then the final settle`);
        await sweepPage(tabId, 'retry', SLOW_SWEEP_MS, true);
        const after = await countMissingImages();
        log(`After the slower sweep: missing=${after.missing}/${after.total}`);
      }
    }

    // Batch image verification in one page-context operation. Avoid one
    // executeScript call plus polling loop for every individual image.
    const [imageBatch] = await browser.tabs.executeScript(tabId, {
      code: '(() => { const imgs=[...document.images]; let unresolved=0; for (const img of imgs) { try { img.loading="eager"; } catch (e) {} if (!img.complete || !img.naturalWidth) { unresolved++; try { img.scrollIntoView({block:"nearest",inline:"nearest",behavior:"auto"}); } catch (e) {} } } return {total:imgs.length,unresolved}; })()',
    });
    log(`Rendered image verification: ${(imageBatch && imageBatch.total) || 0} images found; unresolved=${(imageBatch && imageBatch.unresolved) || 0}`);

    // One bounded settle period for all images instead of up to 2 seconds each.
    if (imageBatch && imageBatch.unresolved > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const [imageStatus] = await browser.tabs.executeScript(tabId, {
      code: '(() => { const imgs=[...document.images]; return {total:imgs.length,loaded:imgs.filter(i=>i.complete&&i.naturalWidth>0).length,missing:imgs.filter(i=>!i.complete||!i.naturalWidth).map(i=>i.currentSrc||i.src||"(no src)")}; })()',
    });
    const [imageDetails] = await browser.tabs.executeScript(tabId, {
      code: '(() => [...document.images].map((img,i)=>({i,complete:img.complete,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,rectWidth:Math.round(img.getBoundingClientRect().width),rectHeight:Math.round(img.getBoundingClientRect().height),src:img.getAttribute("src")||"",currentSrc:img.currentSrc||"",srcset:img.getAttribute("srcset")||"",dataSrc:img.getAttribute("data-src")||"",dataLazySrc:img.getAttribute("data-lazy-src")||"",dataOriginal:img.getAttribute("data-original")||"",loading:img.getAttribute("loading")||"",className:img.className||""})))()',
    });
    if (imageDetails) console.table(imageDetails);
    if (imageStatus) log(`Rendered images loaded: ${imageStatus.loaded}/${imageStatus.total}; missing=${imageStatus.missing.length}`);
      try {
        const livePointStacks = await browser.tabs.executeScript(tabId, {
          code: '(' + function() {
            return Array.from(document.images).map(function(img, i) {
              var r = img.getBoundingClientRect();
              if (img.complete === false || img.naturalWidth === 0 || r.width < 200 || r.height < 120) return null;
              var x = r.left + r.width / 2;
              var y = r.top + r.height / 2;
              if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
              return {
                i: i,
                src: img.currentSrc || img.src || '',
                x: Math.round(x), y: Math.round(y),
                stack: document.elementsFromPoint(x, y).slice(0, 8).map(function(el, depth) {
                  var cs = getComputedStyle(el);
                  var er = el.getBoundingClientRect();
                  return {
                    depth: depth,
                    tag: el.tagName,
                    cls: typeof el.className === 'string' ? el.className : '',
                    href: el.getAttribute('href') || '',
                    x: Math.round(er.x), y: Math.round(er.y), w: Math.round(er.width), h: Math.round(er.height),
                    opacity: cs.opacity,
                    visibility: cs.visibility,
                    display: cs.display,
                    zIndex: cs.zIndex,
                    transform: cs.transform,
                    background: cs.backgroundColor,
                    inlineStyle: el.getAttribute('style') || ''
                  };
                })
              };
            }).filter(Boolean);
          } + ')()'
        });
        log('LIVE POINT STACKS JSON: ' + JSON.stringify(livePointStacks && livePointStacks[0] || []));
        const [nestedAnchorState] = await browser.tabs.executeScript(tabId, {code: '(() => [...document.querySelectorAll("a")].map((a,i)=>{ const descendants=[...a.querySelectorAll("a")]; if(!descendants.length) return null; const r=a.getBoundingClientRect(); return {i,href:a.getAttribute("href")||"",cls:typeof a.className==="string"?a.className:"",x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),text:(a.textContent||"").trim().replace(/\\s+/g," ").slice(0,120),descendants:descendants.slice(0,12).map((d,j)=>({j,href:d.getAttribute("href")||"",cls:typeof d.className==="string"?d.className:"",text:(d.textContent||"").trim().replace(/\\s+/g," ").slice(0,120)}))}; }).filter(Boolean))()'});
        log('LIVE NESTED ANCHORS JSON: ' + JSON.stringify(nestedAnchorState || []));
      } catch (e) {
        log('LIVE POINT STACKS FAILED: ' + e);
      }

    // Preserve the visually-loaded state before saving a scriptless srcdoc snapshot.
    // Some themes download images before their reveal/animation class is applied.
    const [visibilityState] = await browser.tabs.executeScript(tabId, {
      code: '(() => { let fixed=0; [...document.images].forEach(img => { if (!(img.complete && img.naturalWidth > 0)) return; const cs=getComputedStyle(img); if (img.closest("article, .post, .post-item, .post-listing")) img.classList.add("tie-appear"); if (cs.opacity === "0") { img.style.setProperty("opacity","1","important"); fixed++; } if (cs.visibility === "hidden") { img.style.setProperty("visibility","visible","important"); fixed++; } }); return {fixed,images:document.images.length}; })()',
    });
    if (visibilityState) log(`Rendered image visibility normalized: fixed=${visibilityState.fixed}, images=${visibilityState.images}`);

    // Capture only after the page has returned to its normal top-of-page layout.
    await browser.tabs.executeScript(tabId, {code: 'scrollTo(0, 0); window.dispatchEvent(new Event("scroll"));'});
    await new Promise(resolve => setTimeout(resolve, quick ? QUICK_SETTLE_MS : SETTLE_MS));

    // UPDATESCAN_MISSING_IMAGE_CONTAINER_DIAGNOSTIC_V1
    try {
      const [containers] = await browser.tabs.executeScript(tabId, {
        code: '(' + function() {
          const links = Array.from(document.querySelectorAll("a[href]"));
          const candidates = links.filter(el => {
            const r = el.getBoundingClientRect();
            return r.width >= 80 && r.height >= 60 && !el.querySelector("img");
          });
          return {
            images: document.images.length,
            largeLinksWithoutImages: candidates.length,
            samples: candidates.slice(0, 12).map(el => {
              const r = el.getBoundingClientRect();
              return {
                width: Math.round(r.width), height: Math.round(r.height),
                href: el.getAttribute("href"),
                html: el.outerHTML.slice(0, 1800),
              };
            }),
          };
        }.toString() + ')()',
      });
      log('MISSING IMAGE CONTAINERS: ' + JSON.stringify(containers));
    } catch (error) {
      log('MISSING IMAGE CONTAINERS diagnostic failed: ' + error);
    }
    return true;
  } catch (error) {
    log(`Could not scroll/verify rendered tab: ${error}`);
    return false;
  }
}
