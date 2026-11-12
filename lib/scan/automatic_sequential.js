import {getDynamicScanBudgetMs} from './dynamic_budget.js';
// URS_AUTOMATIC_SEQUENTIAL_V1 — manual and locked modes use legacy logic.
import {Page} from '/lib/page/page.js';
import {log} from '/lib/util/log.js';
import {fetchRenderedHtml} from './fetch_rendered.js';
import {fetchPopupRenderedHtml} from './fetch_popup_rendered.js';

// Examine repeated card siblings instead of counting only images already in DOM.
// Uncertain pages are escalated rather than accepted as complete.
export function inspectAutomaticCapture(html, pageUrl = '', options = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;
  if (!body || !html || html.length < 200) return {ok: false, reason: 'empty document'};
  const visibleText = (body.textContent || '').replace(/\s+/g, ' ').trim();
  // Text a visitor could actually read: no scripts, styles, templates or noscript.
  const readableText = (() => {
    const copy = body.cloneNode(true);
    copy.querySelectorAll('script, style, noscript, template').forEach(n => n.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  })();
  const imgs = [...body.querySelectorAll('img')];
  const sources = img => [img.getAttribute('src'), img.getAttribute('currentSrc'),
    img.getAttribute('data-src'), img.getAttribute('data-original')].filter(Boolean);
  const validSrc = src => !/^(about:blank|javascript:|#)/i.test(src) &&
    !/^data:image\/(svg\+xml|gif)/i.test(src);
  const usable = img => sources(img).some(validSrc);
  const missingImages = imgs.filter(img => !usable(img)).length;
  const repeated = [];
  const parents = new Set();
  for (const element of body.querySelectorAll('article, li, [class*="card"], [class*="item"]')) {
    if (element.parentElement) parents.add(element.parentElement);
  }
  for (const parent of parents) {
    const children = [...parent.children];
    if (children.length < 3 || children.length > 2000) continue;
    const groups = new Map();
    for (const child of children) {
      const key = child.tagName + '|' + String(child.className || '').slice(0, 120);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(child);
    }
    for (const siblings of groups.values()) {
      if (siblings.length < 3) continue;
      const withImages = siblings.filter(el => [...el.querySelectorAll('img')].some(usable));
      if (withImages.length < 2) continue;
      const noCover = siblings.filter(el => ![...el.querySelectorAll('img')].some(usable) &&
        !!el.querySelector('a[href]'));
      if (noCover.length) repeated.push({total: siblings.length, missing: noCover.length});
    }
  }
  const missingCards = repeated.length ? Math.max(...repeated.map(x => x.missing)) : 0;

  // URS_STANDARD_DISPLAY_CHECK_V1 — Standard captures only.
  // A Standard snapshot is the page's plain HTML shown WITHOUT its scripts. A
  // gallery whose thumbnails are lazy-loaded (placeholder src + data-src), or
  // whose list is built by scripts after load, looks complete in the markup
  // but is blank when shown. Compare what the markup promises with what can
  // actually appear: images that will show, and tall areas that hold nothing.
  let lazyOnlyImages = 0;
  let blankAreaPx = 0;
  if (options && options.standard === true) {
    const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'data-lazy', 'data-url'];
    const srcCounts = new Map();
    for (const img of imgs) {
      const s = img.getAttribute('src');
      if (s) srcCounts.set(s, (srcCounts.get(s) || 0) + 1);
    }
    const placeholderSrc = src => !src ||
      /^data:image\/(svg\+xml|gif)/i.test(src) ||
      (/^data:/i.test(src) && src.length < 300) ||
      /(blank|placeholder|spacer|transparent|pixel|1x1|lazy|loading)[^\/]*\.(png|gif|jpe?g|svg|webp)(\?|$)/i.test(src) ||
      srcCounts.get(src) >= 4;   // the same picture on many cards is a placeholder
    lazyOnlyImages = imgs.filter(img =>
      LAZY_ATTRS.some(a => img.getAttribute(a)) &&
      placeholderSrc(img.getAttribute('src'))).length;
    const waiting = /load|spinner|skeleton/i;
    for (const el of body.querySelectorAll('[style]')) {
      const m = /(?:^|;)\s*(?:min-)?height\s*:\s*(\d+(?:\.\d+)?)px/i.exec(el.getAttribute('style') || '');
      const px = m ? Number(m[1]) : 0;
      if (px < 1200) continue;
      const innerImgs = [...el.querySelectorAll('img')];
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const realImgs = innerImgs.filter(i => usable(i) &&
        !waiting.test((i.id || '') + ' ' + (i.className || '') + ' ' + (i.getAttribute('src') || ''))).length;
      const hasLoader = !!el.querySelector('[id*="load" i], [class*="load" i], [src*="loader" i], [src*="loading" i], [src*="spinner" i]');
      // Only an area that shows a loading marker counts; a plain spacer does not.
      if (realImgs <= 2 && text.length < 200 && hasLoader) {
        blankAreaPx = Math.max(blankAreaPx, px);
      }
    }
  }
  // URS_STANDARD_STYLE_DEPENDENCE_V1 — Standard captures only.
  // The saved snapshot has the page's markup but not its stylesheets or scripts
  // doing their work. A picture-heavy page whose thumbnails get their size from
  // CSS (no width/height in the markup) shows up as a pile of full-size images
  // and bare links. Such a page needs the rendered capture, so escalate it.
  const LAZY_ANY = img => ['data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'data-lazy', 'data-url'].some(a => img.getAttribute(a));
  let contentImages = 0;
  let unsizedImages = 0;
  let stylesheets = 0;
  let scriptDriven = false;
  if (options && options.standard === true) {
    const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
    const inlineSized = el => /(?:^|;)\s*(?:max-)?(?:width|height)\s*:|aspect-ratio\s*:/i.test(el.getAttribute('style') || '');
    const smallHint = /(icon|avatar|logo|emoji|sprite|flag|badge|favicon|pixel|tracking|spacer)/i;
    // Pictures that are real page content, not icons, logos, avatars or spacers.
    const contentList = imgs.filter(img => {
      if (!usable(img) && !LAZY_ANY(img)) return false;
      const w = px(img.getAttribute('width')), h = px(img.getAttribute('height'));
      if ((w && w <= 64) || (h && h <= 64)) return false;     // small icon
      if (smallHint.test((img.className || '') + ' ' + (img.getAttribute('src') || '') + ' ' + (img.getAttribute('alt') || ''))) return false;
      return true;
    });
    contentImages = contentList.length;
    unsizedImages = contentList.filter(img => {
      const w = px(img.getAttribute('width')), h = px(img.getAttribute('height'));
      return !(w && h) && !inlineSized(img);
    }).length;
    stylesheets = doc.querySelectorAll('link[rel~="stylesheet"][href]').length;
    const noscriptText = [...doc.querySelectorAll('noscript')].map(n => n.textContent || '').join(' ');
    scriptDriven = /(enable|requires?|need).{0,40}javascript|javascript.{0,40}(disabled|required|enabled)/i.test(noscriptText) ||
      !!doc.querySelector('script[type="module"], script[src*="_next"], script[src*="/_nuxt/"], [data-reactroot], [ng-app], [ng-version], #__nuxt, #__layout, #__next, #app[data-v-app], [data-server-rendered], [data-n-head], [data-svelte-h], astro-island') ||
      /window\.__(NUXT|NEXT_DATA|INITIAL_STATE|APOLLO_STATE)__|__NUXT__\s*=|__NEXT_DATA__/.test(html);
    // Result cards shipped as <template> blocks with {TITLE}/{THUMB}/{{name}} slots
    // are filled in by scripts: the saved HTML holds the mould, not the results.
    const templateCards = [...doc.querySelectorAll('template')].filter(t => {
      const inner = t.innerHTML || '';
      return /<(img|article|li|a)\b/i.test(inner) &&
        /\{\{[^}]{1,30}\}\}|\{[A-Z][A-Z_]{1,24}\}|\$\{[a-zA-Z_.]{1,24}\}|%[A-Z_]{2,24}%/.test(inner);
    }).length;
    if (templateCards > 0) scriptDriven = true;
  }
  const styleFail = unsizedImages >= 6 && (stylesheets >= 1 || scriptDriven);
  const usableImages = imgs.filter(usable).length;
  const lazyFail = lazyOnlyImages >= 6 ||
    (lazyOnlyImages >= 3 && lazyOnlyImages >= usableImages * 0.25);
  const blankFail = blankAreaPx >= 1200;
  const pageIsShell = readableText.length < 80 && imgs.filter(usable).length < 2;
  // URL-heavy search shells are not successful Standard captures merely because
  // they contain a navigation menu. Escalate uncertain JS-hydrated results.
  const renderRoot = !!body.querySelector('#__next, #__nuxt, #__layout, #app, #root');
  const emptyRoot = renderRoot && readableText.length < 150 && imgs.length < 2;
  const probablyHydrated = !!body.querySelector('script[src*="_next"], script[src*="/_nuxt/"], script[type="module"], [data-reactroot], #__nuxt');
  const shellWithNoCards = probablyHydrated && imgs.filter(usable).length === 0 &&
    (body.querySelectorAll('a[href]').length < 30 || readableText.length < 600);
  // URS_STANDARD_LISTING_NEEDS_CARDS_V1 — a search/browse/listing page is a page
  // of result cards. If its saved HTML holds fewer than 6 real content pictures
  // and little text, the cards are drawn by scripts (an app shell with only a
  // logo or banner in it) and Standard has not captured the page.
  const strictListingUrl = /\/(search|browse|gallery|posts?|results?)\b/i.test(pageUrl);
  const softListingUrl = /\/(explore|trending|videos?|tags?|genres?|categor(?:y|ies)|releases?|latest|popular|new|watch|list|series|episodes?)\b|[?&]_?(?:sft_)?(?:category|tag|genre|sort|order|orderby|page|paged)=/i.test(pageUrl);
  const listingNoImages = (imgs.filter(usable).length === 0 && strictListingUrl) ||
    (options && options.standard === true && contentImages < 6 &&
      ((strictListingUrl && (scriptDriven || readableText.length < 3000)) ||
       (softListingUrl && scriptDriven && readableText.length < 3000) ||
       // Any script-built page that is mostly empty once scripts are ignored.
       (scriptDriven && readableText.length < 1200)));
  const ok = !pageIsShell && !emptyRoot && !shellWithNoCards && !listingNoImages &&
    missingImages === 0 && missingCards === 0 && !lazyFail && !blankFail && !styleFail;
  const reason = ok ? 'complete' :
    lazyFail ? 'thumbnails are lazy-loaded and not in the saved HTML' :
    blankFail ? 'tall empty area waiting for scripts to fill it' :
    listingNoImages ? 'listing page has no result thumbnails in the saved HTML (filled in by scripts)' :
    styleFail ? 'page needs its CSS/JavaScript to display (thumbnails are unsized in the saved HTML)' :
    'missing content or images';
  return {ok, reason,
    images: imgs.length, readableTextLength: readableText.length, contentImages, unsizedImages, stylesheets, scriptDriven, missingImages, missingCards, repeatedGroups: repeated.length,
    textLength: visibleText.length, lazyOnlyImages, blankAreaPx};
}

// URS_AUTOMATIC_FULL_TIER_BUDGETS_V1
// An early failed verdict must not skip the time reserved for its tier.
// A successful verdict always stops immediately. Do not touch manual modes.
export async function runAutomaticScan(page, processHtml, getStandardHtml, assertValid) {
  let chosen = null;
  let html = null;
  const wait = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  const check = (candidate, label) => {
    assertValid(candidate);
    const report = inspectAutomaticCapture(candidate, page.url, {standard: label === 'Standard'});
    log(`AUTOMATIC ${label} completeness: ${JSON.stringify(report)}`);
    if (!report.ok) {
      const error = new Error(`${label}: ${report.reason} (missing images=${report.missingImages}, missing cards=${report.missingCards})`);
      // These verdicts describe how the page is built (lazy thumbnails, scripts
      // fill the list, needs CSS/JS ...). Fetching the same HTML again cannot
      // change them, so Standard does not retry; only partial/empty responses are retried.
      error.structural = !['missing content or images', 'empty document'].includes(report.reason);
      throw error;
    }
    return candidate;
  };
  const bounded = async (promise, deadline, label) => {
    const remaining = Math.max(1, deadline - Date.now());
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' deadline reached')), remaining);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // URS_REMEMBERED_MODE_V1: once Automatic has settled on a mode for this link,
  // later scans START with it instead of repeating the whole check. A link that
  // needed Popup goes straight to Popup; one that needed Dynamic starts at
  // Dynamic (and moves to Popup if that fails). Standard is always tried first
  // for a link that settled on Standard, as before. Resetting the link
  // ("check again", a changed address or choosing Automatic again) clears
  // scanModeDetected and so starts the full check over.
  const remembered = page.scanModeDetected === true &&
    (page.scanMode === 'dynamic' || page.scanMode === 'popup') ? page.scanMode : null;
  if (remembered) log(`AUTOMATIC remembered mode: ${remembered}; starting there (Standard${remembered === 'popup' ? ' and Dynamic' : ''} skipped)`);
  // Phase 1: Standard has up to 10 seconds. Retry invalid/partial HTTP
  // responses as the content can change while the site hydrates or recovers.
  const standardStart = Date.now();
  const standardEnd = standardStart + 10000;
  if (!remembered) log(`AUTOMATIC 1/3 Standard: 10s maximum, starting ${page.title}`);
  let lastStandardError = '';
  for (let attempt = 1; attempt <= 3 && !chosen && !remembered; attempt++) {
    if (Date.now() >= standardEnd) break;
    try {
      const candidate = await bounded(getStandardHtml(), standardEnd, 'Standard');
      html = check(candidate, 'Standard');
      chosen = 'standard';
      log(`AUTOMATIC Standard PASS on attempt ${attempt}, elapsed=${Date.now() - standardStart}ms; stopping`);
    } catch (err) {
      if (err && err.outageReason) throw err;
      lastStandardError = String(err);
      if (err && err.structural === true) {
        log(`AUTOMATIC Standard attempt ${attempt} rejected: ${lastStandardError}`);
        break;
      }
      log(`AUTOMATIC Standard attempt ${attempt} rejected: ${lastStandardError}`);
      if (!chosen && attempt < 3) {
        const target = standardStart + (attempt === 1 ? 3500 : 7000);
        await wait(Math.min(Math.max(0, target - Date.now()), Math.max(0, standardEnd - Date.now())));
      }
    }
  }
  if (!chosen && !remembered) {
    log(`AUTOMATIC Standard FAIL after ${Date.now() - standardStart}ms; proceeding to Dynamic. Reason: ${lastStandardError}`);
  }
  // Phase 2: Dynamic has its OWN 15 seconds, after Standard finishes.
  // Its three sweeps are run by fetchRenderedHtml; an early failure must
  // not immediately launch Popup because that short-circuits the tier.
  if (!chosen && remembered !== 'popup') {
    const dynamicStart = Date.now();
    const dynamicBudgetMs = await getDynamicScanBudgetMs();
    const dynamicEnd = dynamicStart + dynamicBudgetMs;
    log(`AUTOMATIC 2/3 Dynamic: independent ${dynamicBudgetMs}ms budget; human row-aware scroll`);
    try {
      const candidate = await bounded(
        fetchRenderedHtml(page.url, {automatic: true, maxTotalMs: dynamicBudgetMs}),
        dynamicEnd, 'Dynamic');
      html = check(candidate, 'Dynamic');
      chosen = 'dynamic';
      log(`AUTOMATIC Dynamic PASS after ${Date.now() - dynamicStart}ms; Popup skipped`);
    } catch (err) {
      if (err && err.outageReason) throw err;
      log(`AUTOMATIC Dynamic rejected: ${String(err)}`);
      // URS_NO_IDLE_WAIT_V1: a failed Dynamic verdict moves straight on to Popup.
      log(`AUTOMATIC Dynamic FAIL after ${Date.now() - dynamicStart}ms; proceeding to Popup`);
    }
  }
  if (!chosen) {
    log(`AUTOMATIC 3/3 Popup/Pop-under fallback: Standard and Dynamic budgets exhausted`);
    html = assertValid(await fetchPopupRenderedHtml(page.url, {
      translated: page.translatedPage === true
    }));
    if (!html || html.length < 200) throw new Error('Popup returned empty content');
    chosen = 'popup';
  }
  page.lastScanMode = chosen;
  const result = await processHtml(page, html);
  const saved = await Page.load(page.id);
  if (saved && saved.scanModeAuto === true && saved.scanModeLocked !== true) {
    saved.scanMode = chosen;
    saved.scanModeDetected = true;
    saved.standardModeVerified = chosen === 'standard';
    saved.dynamicModeVerified = chosen === 'dynamic';
    saved.lastScanMode = chosen;
    saved.lastScanNote = (saved.lastScanNote || '') +
      ` Automatic: ${chosen === 'popup' ? 'Popup/Pop-under' :
      chosen === 'dynamic' ? 'Dynamic' : 'Standard'}.`;
    await saved.save();
  }
  log(`AUTOMATIC COMPLETE: ${chosen}; later tiers skipped`);
  return result;
}
