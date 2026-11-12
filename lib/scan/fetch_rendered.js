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
  const automatic = options.automatic === true;
  const startedAt = Date.now();
  // TEST capture mode can request up to 30s to offset screenshot overhead.
  // Normal Automatic still requests (and is limited to) 15s.
  const deadline = automatic ? startedAt + Math.min(60000, Math.max(5000, options.maxTotalMs || 25000)) : null;
  const ensureBudget = () => {
    if (automatic && Date.now() >= deadline)
      throw new Error('Dynamic deadline reached');
  };
  log(`Fetching rendered HTML for: ${url}${quick ? ' (quick look)' : ''}`);

  const tab = await browser.tabs.create({
    url: url,
    active: false,
  });

  let zoomState = null;
  // Cancel pending browser work on timeout. The outer Automatic controller also
  // races the entire operation to bound slow image embedding / browser IPC.
  const stopTimer = automatic ? setTimeout(() => {
    browser.tabs.remove(tab.id).catch(() => {});
  }, Math.max(1, deadline - Date.now())) : null;
  try {
    await waitForTabLoad(tab.id, automatic ? Math.max(100, deadline - Date.now()) : TAB_LOAD_TIMEOUT_MS);
    ensureBudget();
    // Scan at a steady zoom, whatever zoom the user has for this site.
    zoomState = await prepareScanTab(tab.id);
    const renderWait = automatic ? Math.min(300, Math.max(0, deadline - Date.now())) :
      (quick ? QUICK_RENDER_WAIT_MS : RENDER_WAIT_MS);
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

    if (!automatic) {
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

    }
    // Walk through the page so viewport-triggered content gets loaded.
    if (automatic) {
      const covered = await scrollPageForImages(tab.id, {quick: false, automatic: true, endBy: deadline});
      if (!covered) throw new Error('Automatic Dynamic traversal incomplete');
      ensureBudget();
    } else {
      await scrollPageForImages(tab.id, {quick});
    }
    if (!automatic) {
    try {
      const [absoluteLayoutState] = await browser.tabs.executeScript(tab.id, {
        code: `(() => {
          const rows = [...document.querySelectorAll('*')].map((el, i) => {
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
              x.complete && x.naturalWidth > 0;
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
      ensureBudget();
      html = await inlineSnapshotImages(html, url, tab.id);
      ensureBudget();
      // Record the zoom and window size this capture was taken at.
      html = stampSnapshot(html, await readCaptureEnvironment(tab.id, zoomState));
      log(`Rendered HTML extracted with embedded images (${html.length} chars)`);
      return html;
    }
    throw new Error('No HTML content extracted from rendered page');
  } finally {
    if (stopTimer !== null) clearTimeout(stopTimer);
    if (automatic) {
      try { await finishScanTab(tab.id, zoomState); } catch (e) { /* timed-out tab was removed */ }
    } else {
      await finishScanTab(tab.id, zoomState);
    }
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
  const images = [...doc.querySelectorAll("img")];
  const entries = [];
  const uniqueUrls = [];
  const seenUrls = new Set();
  const dataUrlCache = new Map();
  let embedded = 0;
  let failed = 0;

  for (const img of images) {
    const src = img.getAttribute("src") || "";
    const lazySource = [
      "data-src", "data-lazy-src", "data-original"
    ].map(name => img.getAttribute(name) || "")
      .find(value => value && !/^(data:|blob:)/i.test(value));

    // Prefer a real lazy source only when src is empty or a placeholder.
    const placeholder = !src ||
      src.startsWith("data:image/svg+xml") ||
      src.startsWith("data:image/gif");

    const resolvedSrc = placeholder && lazySource ?
      lazySource : (img.getAttribute("data-updatescan-resolved-src") || src);

    if (!resolvedSrc || /^(data:|blob:)/i.test(resolvedSrc)) continue;

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
  // URS_LIVE_VIEWPORT_SWEEP_V1
  // Run the traversal inside the page to avoid one extension IPC
  // round-trip for every viewport step.
  const config = {label, targetMs, waitEvenIfShort,
                   keepBottom: arguments.length > 5 && arguments[5] === true,
                    // Explicit diagnostic experiment: exactly one second per viewport.
                    pacedTest: arguments.length > 6 && arguments[6] === true,
                  deadline: endBy ? endBy - QUICK_READ_MS : null};

  const [result] = await browser.tabs.executeScript(tabId, {
    runAt: 'document_end',
    code: '(' + async function(cfg) {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const measure = () => ({
        height: Math.max(document.documentElement.scrollHeight,
                         document.body ? document.body.scrollHeight : 0),
        viewport: window.innerHeight
      });
      const move = y => {
        window.scrollTo(0, y);
        window.dispatchEvent(new Event('scroll'));
      };
      const expired = () => cfg.deadline !== null &&
        Date.now() > cfg.deadline;

      const initial = measure();
      if (!initial.viewport) return {ok: false, reason: 'no viewport'};

      const stepRatio = 0.95;
      const step = Math.max(1, Math.floor(initial.viewport * stepRatio));
      // URS_INITIAL_PAGE_GROWTH_FIX_V1
      // A framework may initially report only the viewport height.
      // Never declare the sweep complete before remeasuring after render.
      let initialBottom = Math.max(0, initial.height - initial.viewport);

      if (initialBottom === 0) {
        await pause(cfg.waitEvenIfShort
          ? cfg.targetMs
          : Math.min(cfg.targetMs, SWEEP_IDLE));

        const afterInitialRender = measure();
        initialBottom = Math.max(0,
          afterInitialRender.height - afterInitialRender.viewport);

        if (initialBottom === 0) {
          // A second brief check protects against late DOM hydration.
          await pause(400);
          const secondCheck = measure();
          initialBottom = Math.max(0,
            secondCheck.height - secondCheck.viewport);
        }

        if (initialBottom === 0) {
          return {ok: true, steps: 0,
                  initialHeight: initial.height,
                  finalHeight: measure().height,
                  reachedBottom: true, unscrollable: true};
        }
      }

      const planned = Math.max(1, Math.ceil(initialBottom / step));
      const normalDelay = cfg.pacedTest ? 1000 : Math.min(1200,
        Math.max(planned > 24 ? 45 : 120,
                 (cfg.targetMs - 1000) / planned));

      let y = 0;
      let steps = 0;
      let stableBottom = 0;
      let lastBottom = -1;
      let reachedBottom = false;
      const maxSteps = 600;

      // Measure the document again on every step. Do not trust its
      // initial scrollHeight after lazy-loaded content is inserted.
      while (steps < maxSteps && !expired()) {
        const before = measure();
        const bottom = Math.max(0, before.height - before.viewport);

        move(Math.min(y, bottom));
        steps++;

        await pause(normalDelay);

        const after = measure();
        const newBottom = Math.max(0, after.height - after.viewport);
        const actualY = window.scrollY;

        if (actualY >= newBottom - 3) {
          if (lastBottom === newBottom) stableBottom++;
          else stableBottom = 1;
          lastBottom = newBottom;

          // The bottom must remain stable across two checks.
          if (stableBottom >= 2) {
            reachedBottom = true;
            break;
          }
           if (!cfg.pacedTest) await pause(350);
           y = newBottom;
        } else {
          stableBottom = 0;
          y = Math.min(newBottom, Math.max(y + step, actualY + step));
        }
      }

      const finalSize = measure();

      if (!expired()) {
        move(Math.max(0, finalSize.height - finalSize.viewport));
         await pause(cfg.pacedTest ? 1000 : 400);
 
         // Check again after the bottom dwell because some sites
        // append another row when the last row becomes visible.
        const finalCheck = measure();
        const latestBottom = Math.max(0,
          finalCheck.height - finalCheck.viewport);
        if (latestBottom > window.scrollY + 3) {
          reachedBottom = false;
        }
        if (!cfg.keepBottom) {
           move(0);
           await pause(cfg.pacedTest ? 150 : 600);
        }
      }

      return {
        // A deadline crossed during the final bottom dwell or scroll restore
        // must not invalidate a traversal that already confirmed a stable
        // bottom. The live bottom-growth recheck above still clears
        // reachedBottom when the page appends additional rows.
        ok: reachedBottom,
        steps,
        initialHeight: initial.height,
        finalHeight: measure().height,
        reachedBottom,
        limitHit: steps >= maxSteps
      };
    }.toString().replace('SWEEP_IDLE', '1500') +
    ')(' + JSON.stringify(config) + ')'
  });

  log('URS LIVE VIEWPORT SWEEP ' + label + ': ' +
      JSON.stringify(result));

  // Fail closed rather than saving a snapshot whose bottom
  // could not be reached and verified.
  return !!result && result.ok === true;
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
// URS_DIRECT_LAZY_LOAD_V2
// Load unresolved lazy image sources without changing loaded real images.
async function resolveLazyImages(tabId) {
  try {
    const [state] = await browser.tabs.executeScript(tabId, {
      runAt: "document_end",
      code: '(' + async function() {
        const targets = [];

        for (const img of document.images) {
          const current = img.currentSrc || img.src || "";
          const placeholder = !current ||
            current.startsWith("data:image/svg+xml");

          if (!placeholder) continue;

          const raw = [
            "data-src", "data-lazy-src", "data-original"
          ].map(key => img.getAttribute(key) || "")
            .find(value => {
              try {
                const url = new URL(value, location.href);
                return url.protocol === "https:" ||
                       url.protocol === "http:";
              } catch (e) {
                return false;
              }
            });

          if (!raw) continue;
          const candidate = new URL(raw, location.href).href;
          const originalSrc = img.getAttribute("src");

          targets.push(new Promise(resolve => {
            let settled = false;
            let timer;

            const finish = success => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              img.removeEventListener("load", onload);
              img.removeEventListener("error", onerror);

              if (!success) {
                if (originalSrc === null)
                  img.removeAttribute("src");
                else
                  img.setAttribute("src", originalSrc);
              }

              resolve(success);
            };

            const onload = () => finish(
              img.complete && img.naturalWidth > 0 &&
              img.naturalHeight > 0
            );
            const onerror = () => finish(false);

            img.addEventListener("load", onload);
            img.addEventListener("error", onerror);
            timer = setTimeout(() => finish(false), 1800);

            try {
              img.loading = "eager";
              img.removeAttribute("srcset");
              img.setAttribute("src", candidate);
              if (img.complete && img.naturalWidth > 0 &&
                  img.naturalHeight > 0) finish(true);
            } catch (error) {
              finish(false);
            }
          }));
        }

        const results = await Promise.all(targets);
        return {
          attempted: targets.length,
          loaded: results.filter(Boolean).length,
          failed: results.filter(value => !value).length
        };
      }.toString() + ')()'
    });

    log("DIRECT LAZY IMAGE LOAD: " + JSON.stringify(state));
    return state;
  } catch (error) {
    log("DIRECT LAZY IMAGE LOAD FAILED: " + String(error));
    return null;
  }
}

async function imagesAllLoaded(tabId) {
  try {
    const [state] = await browser.tabs.executeScript(tabId, {
      runAt: "document_end",
      code: '(' + function() {
        const imgs = [...document.images];
        let loaded = 0, missing = 0, ignored = 0;

        for (const img of imgs) {
          try { img.loading = "eager"; } catch (e) {}

          const r = img.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) {
            ignored++;
            continue;
          }

          const src = img.currentSrc || img.src || "";
          const lazy = [
            "data-src", "data-lazy-src", "data-original"
          ].map(key => img.getAttribute(key) || "")
            .find(Boolean);

          const placeholder =
            !src ||
            src.startsWith("data:image/svg+xml") ||
            src.startsWith("data:image/gif");

          if (placeholder || !img.complete ||
              img.naturalWidth === 0 ||
              (lazy && /^https?:/.test(lazy) &&
               src.startsWith("data:"))) {
            missing++;
          } else {
            loaded++;
          }
        }

        const containers = [
          ...document.querySelectorAll(
            '[class*="lazy-load-image"], [data-src], ' +
            '[data-lazy-src], [data-original]'
          )
        ].filter(el => {
          if (el.tagName === "IMG" || el.querySelector("img"))
            return false;
          const r = el.getBoundingClientRect();
          return r.width >= 40 && r.height >= 40;
        }).length;

        return {
          total: imgs.length,
          loaded, missing, ignored, containers
        };
      }.toString() + ')()'
    });

    log("ADAPTIVE IMAGE CHECK: " + JSON.stringify(state));
    return !!state && state.missing === 0 &&
      state.containers === 0;
  } catch (error) {
    log("ADAPTIVE IMAGE CHECK FAILED: " + String(error));
    return false;
  }
}

// TEST MODE: diagnostic images are independent of the saved snapshot.
// Downloading is explicitly opted into using the toolbar checkbox.
async function ursRecordDiagnosticPass(tabId, pass, expected, covered, note = '') {
  // TEST ONLY. Independently store an inspectable scrolling gallery per pass.
  // captureTab sees one viewport, not a full page; sample successive scroll positions.
  try {
    const stored = await browser.storage.local.get(['ursDiagnosticPassCaptures', 'ursLastPassCapture']);
    if (stored.ursDiagnosticPassCaptures !== true) return;
    const record = stored.ursLastPassCapture || {passes: [], startedAt: Date.now()};
    let state = null, captureError = null;
    const screenshots = [];
    const failures = [];
    try {
      const result = await browser.tabs.executeScript(tabId, {
        code: `(() => ({title: document.title, url: location.href,
          scrollY: window.scrollY,
          height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
          viewport: innerHeight, images: document.images.length,
          loaded: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length,
          missing: [...document.images].filter(i => !i.complete || !i.naturalWidth).length,
          htmlSize: document.documentElement.outerHTML.length}))()`
      });
      state = result && result[0];
    } catch (error) { captureError = 'DOM: ' + String(error); }
    const originalY = state && Number.isFinite(state.scrollY) ? state.scrollY : 0;
    const height = state && state.height ? state.height : 0;
    const viewport = state && state.viewport ? state.viewport : 0;
    const bottom = Math.max(0, height - viewport);
    const stride = Math.max(1, Math.floor(viewport * 0.87));
    const totalPositions = Math.max(1, Math.ceil(bottom / stride) + 1);
    const maxFrames = record.mode === 'Automatic Dynamic' ? 3 : 12;
    const positions = [];
    for (let i = 0; i < Math.min(totalPositions, maxFrames); i++) {
      const y = totalPositions <= maxFrames
        ? Math.min(bottom, i * stride)
        : Math.round(bottom * i / (maxFrames - 1));
      if (!positions.includes(y)) positions.push(y);
    }
    try {
      for (let i = 0; i < positions.length; i++) {
        const y = positions[i];
        try {
          await browser.tabs.executeScript(tabId, {
            code: `window.scrollTo(0, ${y}); window.dispatchEvent(new Event('scroll'));`
          });
          await new Promise(resolve => setTimeout(resolve, 115));
          const screenshot = await browser.tabs.captureTab(tabId, {format: 'jpeg', quality: 55});
          screenshots.push({y, screenshot});
        } catch (error) { failures.push(`Segment ${i + 1} at y=${y}: ${String(error)}`); }
      }
    } finally {
      try { await browser.tabs.executeScript(tabId, {code: `window.scrollTo(0, ${originalY})`}); }
      catch (error) { failures.push('Restore scroll: ' + String(error)); }
    }
    if (failures.length) captureError = [captureError, ...failures].filter(Boolean).join('; ');
    const entry = {pass, expected, covered, note, at: new Date().toISOString(),
      state, screenshots, screenshot: screenshots[0]?.screenshot || null,
      captureError, totalPositions, sampled: totalPositions > maxFrames};
    record.passes = Array.isArray(record.passes) ? record.passes : [];
    record.passes.push(entry);
    record.url = (state && state.url) || record.url || '';
    record.status = note || `Captured pass ${pass}/${expected}`;
    await browser.storage.local.set({ursLastPassCapture: record});
    // URS_NO_AUTO_DOWNLOAD_V1: captures are kept only in extension storage (they
    // are replaced by the next test scan). Nothing is written to the disk
    // automatically; use "Save" in the diagnostic viewer to keep a report.
    log('URS TEST PASS ' + pass + ': ' + JSON.stringify({
      segmentCount: screenshots.length, totalPositions, sampled: entry.sampled,
      imageCount: state?.images, missing: state?.missing, captureError
    }));
  } catch (error) { log('URS TEST diagnostic recording failed: ' + error); }
}
async function ursDiagnosticFailure(note) {
  try {
    const stored = await browser.storage.local.get(['ursDiagnosticPassCaptures','ursLastPassCapture']);
    if (stored.ursDiagnosticPassCaptures !== true || !stored.ursLastPassCapture) return;
    const record = stored.ursLastPassCapture;
    record.status = `FAILED: ${note}`;
    record.failureAt = new Date().toISOString();
    await browser.storage.local.set({ursLastPassCapture: record});
  } catch (error) {log('URS TEST failure status update failed: ' + error);}
}

// URS_FINAL_TOP_BOTTOM_DWELL_V1
// Restore top-of-gallery lazy content briefly, then return to the rendered
// bottom before DOM extraction. This is positioning, not proof of coverage.
async function ursFinalTopBottomDwell(tabId, endBy = null) {
  const remaining = endBy ? endBy - Date.now() : Infinity;
  // Preserve a small margin for serialization and the existing validator.
  // In normal mode there is no time cap at this call site.
  if (remaining < 1400) {
    log('URS FINAL TOP/BOTTOM: insufficient deadline margin; skipping extra dwell');
    return;
  }
  const [state] = await browser.tabs.executeScript(tabId, {
    runAt: 'document_end',
    code: '(' + async function() {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const move = y => {
        window.scrollTo(0, y);
        window.dispatchEvent(new Event('scroll'));
      };
      move(0);
      await pause(500);
      const top = {scrollY: window.scrollY, images: document.images.length};
      const bottom = () => Math.max(0,
        Math.max(document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0) - window.innerHeight);
      move(bottom());
      await pause(500);
      // Lazy galleries may append a final row after the bottom becomes visible.
      if (bottom() > window.scrollY + 3) move(bottom());
      return {top, bottom: {scrollY: window.scrollY, images: document.images.length}};
    }.toString() + ')()'
  });
  log('URS FINAL TOP/BOTTOM: ' + JSON.stringify(state));
}

// USR1_HUMAN_ROW_SCAN_V1 — adapts the verified Doujin Timing Lab human-scroll
// geometry and extension-controlled smoothstep approach for arbitrary websites.
// No page-side timer loops, screenshots or permanent DOM filler modifications.
async function humanRowDynamicScan(tabId, deadline) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const timeLeft = () => Math.max(0, deadline - Date.now());
  // Reserve 3.5s for snapshot extraction, embedding, and cleanup.
  let scanEnd = deadline - 3500;
  const active = () => Date.now() < scanEnd;
  // URS_TEST_PASS_CAPTURE_V1: the toolbar checkbox "Test: capture each Dynamic
  // pass". Images of the page are recorded after each stage; the time they take
  // is added back so they never shorten the scan itself (the Dynamic budget is
  // extended by the same test overhead, see dynamic_budget.js).
  let capturePasses = false;
  try {
    const stored = await browser.storage.local.get('ursDiagnosticPassCaptures');
    capturePasses = stored.ursDiagnosticPassCaptures === true;
    if (capturePasses) {
      await browser.storage.local.set({ursLastPassCapture: {
        url: '', startedAt: Date.now(), passes: [], status: 'Scanning',
        mode: 'Automatic Dynamic',
      }});
    }
  } catch (error) { log('TEST PASS CAPTURE setup failed: ' + error); }
  const recordPass = async (pass, covered, note) => {
    if (!capturePasses) return;
    const started = Date.now();
    try { await ursRecordDiagnosticPass(tabId, pass, 3, covered, note); }
    catch (error) { log('TEST PASS CAPTURE failed: ' + error); }
    scanEnd += Date.now() - started;
  };
  const execute = async code => {
    const [answer] = await browser.tabs.executeScript(tabId, {runAt: 'document_end', code});
    return answer;
  };
  const state = () => execute(`(() => {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    // Slides of a horizontal carousel that sit past the edge of the screen or are
    // clipped away by a scrolling/hidden-overflow parent are never shown to a
    // visitor and their lazy images never load. They are not part of what must
    // be complete. Judged horizontally only: the page itself scrolls vertically.
    const clipCache = new Map();
    const clipBox = p => {
      if (!clipCache.has(p)) {
        const cs = getComputedStyle(p);
        clipCache.set(p, cs.overflowX !== 'visible' ? p.getBoundingClientRect() : null);
      }
      return clipCache.get(p);
    };
    const onScreenX = el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return false;
      const need = Math.min(r.width * 0.5, 60);
      let left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
      if (right - left < need) return false;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const b = clipBox(p);
        if (!b || p === document.body) continue;
        left = Math.max(left, b.left); right = Math.min(right, b.right);
        if (right - left < need) return false;
      }
      return true;
    };
    const anchors = [...document.querySelectorAll('a[href]')].filter(a => {
      const r=a.getBoundingClientRect();return r.width>=80 && r.height>=65 && onScreenX(a);
    });
    const candidates = anchors.length >= 4 ? anchors : [...document.images].filter(i => {
      const r=i.getBoundingClientRect();return r.width>=75 && r.height>=65 && onScreenX(i);
    });
    const parentIds = new Map();
    const parentId = p => { if (!parentIds.has(p)) parentIds.set(p, parentIds.size); return parentIds.get(p); };
    const cards = candidates.map((el,i) => {
      const r=el.getBoundingClientRect();
      const imgs = el.tagName==='IMG' ? [el] : [...el.querySelectorAll('img')];
      const par = el.parentElement;
      const cls = String(el.className||'').slice(0,80), pcls = par ? String(par.className||'').slice(0,80) : '';
      return {id:i,y:Math.round(r.top+scrollY),bottom:Math.round(r.bottom+scrollY),
        w:Math.round(r.width),h:Math.round(r.height),pid:par?parentId(par):-1,
        sig:el.tagName+'|'+cls+'|'+(par?par.tagName:'')+'|'+pcls, sigUseful:!!(cls||pcls),
        label:((el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)+' '+String(el.getAttribute('href')||'').slice(-40)).trim(),
        loaded:imgs.some(x=>x.complete&&x.naturalWidth>0), hasImage:imgs.length>0};
    });
    // Only links that look like the page's real picture cards can be "missing a
    // picture": same markup/classes as a card that has one, or the same parent
    // and a similar size. Menu items, logos and buttons that merely happen to
    // be large links are not cards.
    const imgCards = cards.filter(c=>c.hasImage);
    const similar = (a,b) => Math.abs(a.w-b.w)<=b.w*0.35 && Math.abs(a.h-b.h)<=b.h*0.35;
    const relevantCards = imgCards.length>=2 ? cards.filter(c => c.hasImage ||
      imgCards.some(k => (c.sigUseful && k.sig===c.sig && similar(c,k)) ||
                         (k.pid===c.pid && similar(c,k)))) : [];
    const missingList = relevantCards.filter(c=>!c.loaded);
    const missingCards = missingList.length;
    const missingInfo = missingList.slice(0,4).map(c=>c.w+'x'+c.h+' @'+c.y+' "'+c.label+'"');
    // Hidden images (age-gate dialogs, menus, tracking pixels) that never load are
    // not part of the page the user sees; only count images that are on screen
    // layout or that did load.
    const shown = [...document.images].filter(i => {
      if (i.complete && i.naturalWidth > 0) return true;
      const r = i.getBoundingClientRect();
      return i.getClientRects().length > 0 && r.width >= 8 && r.height >= 8 &&
        getComputedStyle(i).visibility !== 'hidden' && onScreenX(i);
    });
    // A visible loading indicator (spinner, skeleton, "Searching...") means the
    // results are still on their way. Words are matched inside class/id tokens
    // split on - and _ so "lazyload" or "loaded" are not mistaken for loading.
    const LOAD_WORDS = /^(loading|loader|preloader|spinner|skeleton|shimmer|searching)$/i;
    const hasLoadWord = v => String(v||'').split(/\\s+/).some(tok => tok.split(/[-_]+/).some(w => LOAD_WORDS.test(w)));
    const shownBox = el => {
      if (!el.getClientRects().length) return false;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 12 && r.height > 3 && cs.visibility !== 'hidden' && cs.opacity !== '0' && cs.display !== 'none';
    };
    let loading = !!document.querySelector('[aria-busy="true"]');
    if (!loading) {
      for (const el of document.querySelectorAll('body *')) {
        if (el.tagName === 'IMG' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE') continue;
        const hit = hasLoadWord(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || hasLoadWord(el.id);
        const text = !hit && !el.children.length && /^\\s*(searching|loading)\\b[\\s\\S]{0,40}$/i.test(el.textContent || '');
        if ((hit || text) && shownBox(el)) { loading = true; break; }
      }
    }
    const expectCards = /\\/(search|browse|gallery|posts?|results?|explore|trending|videos?|tags?|genres?|categor(?:y|ies)|releases?|latest|popular|new|watch|list|series|episodes?)\\b|[?&](s|q|query|search|sort|order|page|paged|category|tag|genre)=/i.test(location.href);
    return {y:scrollY,height,viewport:innerHeight,cards,missingCards,missingInfo,loading,expectCards,
      textLength:(document.body?.innerText||'').trim().length,
      imageCount:shown.length,imagesReady:shown.filter(i=>i.complete&&i.naturalWidth>0).length};
  })()`);
  const move = async y => execute(`(()=>{window.scrollTo(0,${Math.max(0,Math.round(y))});return window.scrollY})()`);
  // The timing controller lives in the extension. Background tabs do not get
  // to throttle this loop's 10ms sleeps into 1000ms page timers.
  const humanMove = async (target, pace=700) => {
    const before=await state();const maxY=Math.max(0,before.height-before.viewport);
    const finish=Math.max(0,Math.min(maxY,Math.round(target)));
    const delta=finish-before.y;
    if(Math.abs(delta)<2)return before.y;
    const duration=Math.min(8000,Math.max(450,Math.abs(delta)/pace*1000));
    const t0=Date.now();let reached=before.y;
    while(active()) {
      const progress=Math.min(1,(Date.now()-t0)/duration);
      const ease=progress*progress*(3-2*progress);
      reached=await move(before.y+delta*ease);
      if(progress>=1)break;
      await wait(Math.min(10,Math.max(1,scanEnd-Date.now())));
    }
    return reached;
  };
  let before=await state();
  if(!before.viewport || !active()){
    if (capturePasses) await ursDiagnosticFailure('Page has no viewport, or no time left to start');
    return false;
  }
  await recordPass(0, null, 'Initial page before the human scroll');
  // First let a hydrated grid collapse into its real CSS geometry, as the
  // successful Timing Lab does. Do not spend most of the deadline waiting.
  await wait(Math.min(300,Math.max(0,scanEnd-Date.now())));
  let current=await state();
  // Results that arrive after the page loads (search/browse pages that fetch
  // their list from an API) must be waited for, not judged while empty. Wait
  // while a loading indicator is showing, or while a listing-style page still
  // has no cards. Pages that are not loading and not listings are not delayed.
  const noResults = st => st.cards.length < 3 || st.imageCount < 3;
  if(active() && (current.loading || (current.expectCards && noResults(current)))) {
    const waitStarted=Date.now();
    const waitUntil=Math.max(Date.now(), scanEnd-7000);   // keep time for the scroll pass
    let calm=0;
    while(active() && Date.now()<waitUntil) {
      await wait(Math.min(250,Math.max(0,waitUntil-Date.now())));
      current=await state();
      const stillWaiting=current.loading || (current.expectCards && noResults(current));
      calm = stillWaiting ? 0 : calm+1;
      if(calm>=2) break;
    }
    log(`USR1 human row scan: waited ${Date.now()-waitStarted}ms for results; loading=${current.loading}; cards=${current.cards.length}; images=${current.imageCount}`);
  }
  // When an unhydrated grid temporarily stacks cards into one enormous
  // column, its initial height is misleading. Give layout up to 1.5 seconds
  // to settle before computing the human-pass distance (no page timers).
  const layoutStarted=Date.now();
  while(active() && current.cards.length>=8 &&
        current.height>current.viewport*18 &&
        Date.now()-layoutStarted<1500) {
    await wait(150);
    current=await state();
  }
  // Initial human pass: down, short bottom pause and up. Avoid repeated passes
  // when a page grows indefinitely; row positioning will expose late cards.
  for(let growth=0;growth<2&&active();growth++) {
    const bottom=Math.max(0,current.height-current.viewport);
    await humanMove(bottom);
    current=await state();
    if(Math.max(0,current.height-current.viewport)<=bottom+3)break;
  }
  if(active())await wait(Math.min(400,Math.max(0,scanEnd-Date.now())));
  if(active())await humanMove(0);
  current=await state();
  await recordPass(1, true, 'Human pass down and back up completed');
  // Plan physical rows by actual card tops. No site selectors or URL patterns.
  const rows=[];
  for(const card of [...current.cards].sort((a,b)=>a.y-b.y || a.id-b.id)) {
    const last=rows[rows.length-1];
    if(last && Math.abs(last.y-card.y)<=35){last.bottom=Math.max(last.bottom,card.bottom);last.cards.push(card);}
    else rows.push({y:card.y,bottom:card.bottom,cards:[card]});
  }
  if(rows.length>0 && active()) {
    // Each incomplete row gets one short exposure check; group adjacent rows
    // that fit the viewport and never wait through the whole row timeout.
    let index=0;
    while(index<rows.length&&active()){
      const first=rows[index];let last=index;
      while(last+1<rows.length && rows[last+1].bottom-first.y<=current.viewport-30)last++;
      const end=rows[last].bottom;
      let now=await state();
      const visible=first.y>=now.y+10 && end<=now.y+now.viewport-10;
      if(!visible)await humanMove(first.y-15);
      if(!active())break;
      await wait(Math.min(200,Math.max(0,scanEnd-Date.now())));
      now=await state();
      // Newly inserted images are checked on each visit, independently from
      // the initial card set; the final DOM extraction does the real audit.
      if(now.imageCount>0&&now.imagesReady===now.imageCount&&now.missingCards===0){
        log(`USR1 human row scan: ${now.imagesReady}/${now.imageCount} decoded; stop early`);
        break;
      }
      index=last+1;
    }
  }
  // A card that stayed empty after its one row visit gets more chances: leave
  // it, come back, and wait a little (the lab's row re-entry). Capped so a
  // genuinely broken card cannot use up the whole time limit.
  for(let round=0;round<3&&active();round++){
    const check=await state();
    const empty=check.cards.filter(c=>c.hasImage&&!c.loaded);
    if(!empty.length||check.missingCards===0)break;
    log(`USR1 human row scan: retry round ${round+1}, ${empty.length} empty card(s)`);
    const targets=[...empty].sort((a,b)=>a.y-b.y).slice(0,8);
    await humanMove(Math.max(0,targets[0].y-check.viewport*0.6));
    for(const card of targets){
      if(!active())break;
      await humanMove(Math.max(0,card.y-15));
      await wait(Math.min(450,Math.max(0,scanEnd-Date.now())));
    }
  }
  if(active())await humanMove(0);
  const final=await state();
  // URS_PAINT_CHECK_V1: "loaded" is not "visible". Count the real pictures
  // (60px or larger) that are loaded and meant to be on the page, and how many
  // of them can actually be seen (displayed, not transparent, not hidden).
  // Slides that are only pushed past the edge of a carousel are left out.
  const paint = await execute(`(() => {
    const clipCache = new Map();
    const clipBox = p => { if (!clipCache.has(p)) { clipCache.set(p, getComputedStyle(p).overflowX !== 'visible' ? p.getBoundingClientRect() : null); } return clipCache.get(p); };
    const pushedAside = el => {
      const r = el.getBoundingClientRect();
      if (!el.getClientRects().length || r.width <= 0) return false;
      let left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
      const need = Math.min(r.width * 0.5, 60);
      if (right - left < need) return true;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const b = p === document.body ? null : clipBox(p);
        if (!b) continue;
        left = Math.max(left, b.left); right = Math.min(right, b.right);
        if (right - left < need) return true;
      }
      return false;
    };
    const seen = el => {
      if (!el.getClientRects().length) return 'not displayed';
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return 'tiny ' + Math.round(r.width) + 'x' + Math.round(r.height);
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none') return 'display:none on ' + (n.tagName + '.' + String(n.className||'').slice(0,30));
        if (cs.visibility === 'hidden') return 'visibility:hidden';
        if (parseFloat(cs.opacity) < 0.05) return 'opacity:0 on ' + (n.tagName + '.' + String(n.className||'').slice(0,30));
      }
      return '';
    };
    const real = [...document.images].filter(i => i.complete && i.naturalWidth >= 60 && i.naturalHeight >= 60);
    const meant = real.filter(i => !pushedAside(i));
    const hidden = [];
    let visible = 0;
    for (const i of meant) { const why = seen(i); if (!why) visible++; else if (hidden.length < 3) hidden.push(why); }
    return {loaded: meant.length, visible, hidden};
  })()`);
  const imagesInvisible = !!paint && paint.loaded >= 3 && paint.visible * 5 < paint.loaded;
  const success = !final.loading && !imagesInvisible && (final.imageCount>0 ?
    (final.imagesReady===final.imageCount && final.missingCards===0) :
    (final.textLength>120 && !(final.expectCards && final.cards.length<3)));
  log(`USR1 human row scan: ${final.imagesReady}/${final.imageCount} images decoded; `+
    `rows planned=${rows.length}; missing cards=${final.missingCards}; elapsed budget left=${timeLeft()}ms; complete=${success}`);
  const whyIncomplete = `Row checks incomplete (images ${final.imagesReady}/${final.imageCount}, ` +
    `${final.loading ? 'STILL LOADING, ' : ''}${imagesInvisible ? `IMAGES LOADED BUT NOT VISIBLE (${paint.visible} of ${paint.loaded} can be seen: ${paint.hidden.join(' | ')}), ` : ''}cards without picture ${final.missingCards}${final.missingInfo && final.missingInfo.length ? ': ' + final.missingInfo.join(' | ') : ''})`;
  if (!success) log('USR1 human row scan: ' + whyIncomplete);
  await recordPass(2, success, success ? 'Row checks completed' : whyIncomplete);
  if (!success && capturePasses) await ursDiagnosticFailure(whyIncomplete);
  return success;
}

export async function scrollPageForImages(tabId, options = {}) {
  const quick = options.quick === true;
  const automatic = options.automatic === true;
  const endBy = options.endBy || null;
  // Automatic's timed gallery traversal uses extension-side IPC, not page-side timers.
  if (automatic) return await humanRowDynamicScan(tabId, endBy);

  try {
    // Slow, steady sweeps: each one a little slower than the last, so lazy
    // images and slow-loading ads all get time to arrive.
    // Three complete traversals. The hard deadline can shorten a pass; an
    // incomplete final traversal is rejected rather than being saved.
    const remaining = automatic ? Math.max(0, endBy - Date.now() - 3500) : 0;
    // 3:4:8 relative pacing, but reserve time for rendering, embedding and
    // the final validation within the complete 15-second Dynamic limit.
    const autoSweepBudget = Math.min(11500, remaining);
    const sweeps = automatic ? [3, 4, 8].map(weight =>
      Math.max(250, Math.floor(autoSweepBudget * weight / 15))) :
      (quick ? [QUICK_SWEEP_MS] : SWEEP_TARGET_MS);
    let completedSweeps = 0;
    let firstPassImagesReady = false;
    let firstPassImageCount = 0;
    // Explicit test mode only. Data is retained for viewing even when a scan fails.
    let capturePasses = false;
    try {
      const stored = await browser.storage.local.get('ursDiagnosticPassCaptures');
      capturePasses = stored.ursDiagnosticPassCaptures === true;
      if (capturePasses) {
        await browser.storage.local.set({ursLastPassCapture: {
          url: options.url || '', startedAt: Date.now(), passes: [],
          status: 'Scanning', mode: automatic ? 'Automatic Dynamic' :
            (quick ? 'Quick verification' : 'Manual Dynamic')
        }});
      }
    } catch (error) { log('TEST PASS CAPTURE setup failed: ' + error); }
    if (capturePasses) await ursRecordDiagnosticPass(tabId, 0, sweeps.length, null,
      'Initial page before sweeps');
    for (let pass = 1; pass <= sweeps.length; pass++) {
      if (pass === 3 && !quick && !automatic && await imagesAllLoaded(tabId)) {
        log("DIRECT LAZY: Two full sweeps completed; all discovered images loaded; third sweep not needed");
        break;
      }
      if (automatic && Date.now() >= endBy - 500) {
        log(`AUTOMATIC TRAVERSAL: budget exhausted before pass ${pass}; completed=${completedSweeps}`);
        break;
      }
      let covered;
      try {
         covered = await sweepPage(tabId, `${pass}/${sweeps.length}`,
           sweeps[pass - 1], false, endBy, capturePasses && pass !== 1,
           capturePasses && pass === 1);
      } catch (error) {
        if (capturePasses) {
          await ursRecordDiagnosticPass(tabId, pass, sweeps.length, false,
            `Pass ${pass} exception: ${String(error)}`);
          await ursDiagnosticFailure(`Pass ${pass}: ${String(error)}`);
        }
        throw error;
      }
      if (capturePasses) {
        await ursRecordDiagnosticPass(tabId, pass, sweeps.length, covered,
          covered ? `Pass ${pass} completed` : `Pass ${pass} incomplete`);
        try { await browser.tabs.executeScript(tabId, {code: 'scrollTo(0,0)'}); }
        catch (error) { log('URS TEST scroll restore: ' + error); }
      }
      if (!covered) {
        log(`AUTOMATIC TRAVERSAL: pass ${pass} did not reach a stable bottom; completed=${completedSweeps}`);
        // A completed first traversal may be sufficient if images were loaded
        // then and remain loaded with exactly the same count now. Rechecking
        // prevents a still-growing gallery from being accepted on this basis.
        let stableFirstPass = false;
        if (automatic && completedSweeps >= 1 && firstPassImagesReady &&
            Date.now() < endBy - 75) {
          const [now] = await browser.tabs.executeScript(tabId, {
            code: `(() => ({count: document.images.length, ready: [...document.images].every(i => {
              const r = i.getBoundingClientRect();
              return (r.width === 0 && r.height === 0) ||
                (i.complete && i.naturalWidth > 0);
            })}))()`
          });
          stableFirstPass = !!now && now.ready && now.count === firstPassImageCount &&
            await imagesAllLoaded(tabId);
        }
        if (!automatic || (completedSweeps < 2 && !stableFirstPass)) {
          if (capturePasses) await ursDiagnosticFailure(`Pass ${pass} incomplete`);
          return false;
        }
        log(`AUTOMATIC TRAVERSAL: ${completedSweeps} complete, stable images; allowing final gallery validation`);
        break;
      }
      completedSweeps++;
      if (pass === 1 && !quick) {
        await resolveLazyImages(tabId);
        if (automatic && Date.now() < endBy - 350) {
          const [first] = await browser.tabs.executeScript(tabId, {
            code: '({count: document.images.length})'
          });
          firstPassImageCount = first?.count || 0;
           firstPassImagesReady = firstPassImageCount > 0 && await imagesAllLoaded(tabId);
         }
         if (capturePasses && covered) {
           // One-sweep test: do not run subsequent passes or the final top/bottom
           // dwell. Return to the top for the real HTML extraction, not just the
           // diagnostic screenshots.
           await browser.tabs.executeScript(tabId, {
             code: 'window.scrollTo(0, 0); window.dispatchEvent(new Event("scroll"));'
           });
           log('URS PACED TEST: completed one 1-second/viewport sweep; final position top');
           break;
         }
       }
     }
     if (automatic) {
      if (completedSweeps < 1 ||
          (completedSweeps === 1 && !firstPassImagesReady)) {
        if (capturePasses) await ursDiagnosticFailure('No fully loaded complete traversal');
        return false;
      }
       if (!capturePasses) await ursFinalTopBottomDwell(tabId, endBy);
       log(`AUTOMATIC TRAVERSAL: ${completedSweeps}/3 complete; proceeding to gallery validation`);
      return true;
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
          const budget = 6000;
          function candidates() {
            return [...document.querySelectorAll('a[href]')].filter(link => {
              const rect = link.getBoundingClientRect();
              if (rect.width < 80 || rect.height < 60 ||
                  link.querySelector('img')) return false;

              // Text-only title links are not empty image containers.
              // Keep actual background-image and lazy-source candidates.
              const hasLazySource = link.matches(
                '[data-src], [data-lazy-src], [data-original]'
              ) || !!link.querySelector(
                '[data-src], [data-lazy-src], [data-original]'
              );
              const background = getComputedStyle(link).backgroundImage;
              if (link.textContent.trim() &&
                  !hasLazySource &&
                  (!background || background === 'none')) return false;
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

    // Final top/bottom dwell refreshes lazy rows at both edges before capture.
    // The existing gallery checks still decide whether the page is complete.
    if (!quick) await ursFinalTopBottomDwell(tabId);
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
    await ursRecordDiagnosticPass(tabId, 'error', 3, false, String(error));
    await ursDiagnosticFailure(String(error));
    return false;
  }
}
