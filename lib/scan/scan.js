import {getDynamicScanBudgetMs} from './dynamic_budget.js';
import {PageStore} from '/lib/page/page_store.js';
import {Page} from '/lib/page/page.js';
import {isUpToDate} from '/lib/update/update.js';
import {log} from '/lib/util/log.js';
import {waitForMs} from '/lib/util/promise.js';
import {applyEncoding, detectEncoding} from '/lib/util/encoding.js';
import {matchHtmlWithSelector} from './selector_matcher.js';
import {
  getChanges,
  getChangeSize,
  ContentData,
  changeEnum,
} from './scan_content.js';
import {isMajorChange} from './fuzzy.js';
import {diffWithSummary} from '/lib/diff/diff.js';
import {fetchRenderedHtml} from './fetch_rendered.js';
import {fetchPopupRenderedHtml} from './fetch_popup_rendered.js';
import {runAutomaticScan, inspectAutomaticCapture} from './automatic_sequential.js';


// Allow function mocking
export const __ = {
  log: (...args) => log(...args),
  detectEncoding: (...args) => detectEncoding(...args),
  applyEncoding: (...args) => applyEncoding(...args),
  waitForMs: (...args) => waitForMs(...args),
  isUpToDate: (...args) => isUpToDate(...args),
  isMajorChange: (...args) => isMajorChange(...args),
  matchHtmlWithSelector: (...args) => matchHtmlWithSelector(...args),
  fetchRenderedHtml: (...args) => fetchRenderedHtml(...args),
  fetchPopupRenderedHtml: (...args) => fetchPopupRenderedHtml(...args),

  // Allow private functions to be tested
  updatePageState: updatePageState,
  getHtmlFromResponse: getHtmlFromResponse,
  isJsRenderedContent: isJsRenderedContent,
};

// Wait between scanning pages
const SCAN_IDLE_MS = 2000;

/**
 * Start scanning the pages one at a time. HTML is checked for updates and
 * saved to the PageStore, and the Page objects updated and saved accordingly.
 *
 * @param {Array.<Page>} pageList - Array of pages to scan.
 *
 * @returns {number} The number of new major changes detected.
 */
export async function scan(pageList) {
  let newMajorChangeCount = 0;
  for (const page of pageList) {
    if (await scanPage(page)) {
      newMajorChangeCount++;
    }

    await __.waitForMs(SCAN_IDLE_MS);
  }
  return newMajorChangeCount;
}

/**
 * Scan a single page, check for updates, then save the HTML to the PageStore
 * and updating and save the Page object accordingly. Errors are logged and
 * ignored.
 *
 * Uses a two-stage approach:
 * 1. Try a normal HTTP fetch (fast, works for static pages).
 * 2. If that fails or returns effectively empty/JS-dependent content,
 *    fall back to loading the page in a real browser tab to get rendered DOM.
 *
 * @param {Page} page - Page to scan.
 *
 * @returns {boolean} True if a new major change is detected.
 */
// A temporary failure must not overwrite the last valid page snapshot.
// The first failure is gray. Only a failure at the 3-hour confirmation is red.
const OUTAGE_RECHECK_MS = 3 * 60 * 60 * 1000;

function describeScanFailure(error) {
  if (error && error.outageReason) return error.outageReason;
  const message = String((error && error.message) || error || 'Unable to reach website');
  const code = message.match(/\b(?:5[0-9]{2})\b/);
  if (code) return `HTTP ${code[0]}: website/server unavailable`;
  if (/timeout|timed out/i.test(message)) return 'Connection timed out';
  if (/network|failed to fetch|connection|dns|unreachable/i.test(message))
    return 'Connection failed: site could not be reached';
  return `Scan failed: ${message.slice(0, 140)}`;
}

function detectOutagePage(html) {
  if (typeof html !== 'string' || !html) return '';
  // Rendered Cloudflare pages may have a blank/rewritten <title>, arbitrary
  // markup between "Error code" and "521", and substantial injected HTML.
  // Check human-visible page text as well as raw markup, not just the first
  // 32 KB or a narrowly structured <span>.
  let bodyText = '';
  let title = '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    title = (doc.title || '').replace(/\s+/g, ' ').trim();
    bodyText = (doc.body && doc.body.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 120000);
  } catch (error) {
    // The light-weight raw HTML fallback below also works without DOMParser.
  }
  const raw = html.slice(0, 160000);
  const visible = `${title} ${bodyText}`;
  const cloudflare = /cloudflare|cf-error|cf-wrapper|cf-error-details|cf-ray/i
    .test(`${visible} ${raw}`);
  // Positive identification requires distinctive Cloudflare outage content;
  // an ordinary article discussing Cloudflare or HTTP errors must not count.
  const pageSignature = /web server is down|origin (?:web )?server (?:is )?(?:down|unreachable)|host error|origin error/i
    .test(visible);
  const errorCode = /(?:error\s*code|error\s*[:#]|\|\s*)(?:\s|\D){0,65}(52[0-9]|53[0-9])\b/i
    .exec(visible) || /\b(52[0-9]|53[0-9])\s*:\s*web server is down/i.exec(visible);
  const code = errorCode && errorCode[1];
  const cfFooter = /visit\s+cloudflare\.com|cloudflare\s+ray\s+id/i.test(visible);
  if (cloudflare && (cfFooter || /cf-error|cf-wrapper|cf-error-details/i.test(raw)) &&
      (pageSignature || code)) {
    if (code === '521' || /web server is down/i.test(visible))
      return 'Cloudflare error 521: origin web server is down';
    if (code) return `Cloudflare error ${code}: origin server unavailable`;
    return `Cloudflare: ${title || 'origin server unavailable'}`;
  }
  return '';
}

function assertNotOutagePage(html) {
  const reason = detectOutagePage(html);
  if (reason) {
    const error = new Error(reason);
    error.outageReason = reason;
    throw error;
  }
  return html;
}

async function checkedRenderedHtml(url, options = {}) {
  return assertNotOutagePage(await __.fetchRenderedHtml(url, options));
}

// URS_CONSISTENT_STANDARD_10S_V1: abort HTTP work at deadline,
// including response-body decoding. Callers do not commit timed-out captures.
async function fetchStandardWithDeadline(page, timeoutMs = 10000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(page.url, {signal: controller.signal});
        if (!response.ok) {
          const failure = Error(`[${response.status}] ${response.statusText}`);
          if (response.status >= 500 && response.status <= 599) {
            failure.outageReason = response.status === 521 ?
              'Cloudflare error 521: origin web server is down' :
              `HTTP ${response.status}: website/server unavailable`;
          }
          failure.blocked = response.status === 403 ||
            (response.headers && response.headers.get &&
              response.headers.get('cf-mitigated') === 'challenge');
          throw failure;
        }
        return assertNotOutagePage(await getHtmlFromResponse(response, page));
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Standard scan exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkedPopupRenderedHtml(url, opts) {
  return assertNotOutagePage(await __.fetchPopupRenderedHtml(url, opts));
}

async function restoreLastValidSnapshot(page) {
  try {
    const newer = await PageStore.loadHtml(page.id, PageStore.htmlTypes.NEW);
    if (!newer || !/web server is down|error code|521\s*:/i.test(newer) ||
        !/cloudflare/i.test(newer) || !detectOutagePage(newer)) return;
    const previous = await PageStore.loadHtml(page.id, PageStore.htmlTypes.OLD);
    if (!previous || detectOutagePage(previous)) return;
    await PageStore.saveHtml(page.id, PageStore.htmlTypes.NEW, previous);
    __.log('Restored last valid snapshot after previous Cloudflare error-page capture.');
  } catch (error) {
    __.log(`Could not recover previous snapshot: ${error}`);
  }
}

async function recordScanFailure(page, error) {
  if (!(await page.existsInStorage())) return;
  const current = await Page.load(page.id);
  const now = Date.now();
  const isConfirmation = current.outageCheckAt != null && now >= current.outageCheckAt;
  if (current.outageFirstAt == null) current.outageFirstAt = now;
  if (current.outageCheckAt == null)
    current.outageCheckAt = current.outageFirstAt + OUTAGE_RECHECK_MS;
  await restoreLastValidSnapshot(current);
  current.outageError = describeScanFailure(error);
  current.state = isConfirmation ? Page.stateEnum.DOWN : Page.stateEnum.ERROR;
  current.lastScanNote = `${current.outageError}. ` + (isConfirmation ?
    'Still unavailable at the three-hour recheck.' :
    `Recheck after ${new Date(current.outageCheckAt).toLocaleString()}.`);
  // Save the red status before the notification so a notification API failure
  // can never lose the site's down state.
  const notify = isConfirmation && !current.outageNotified;
  if (notify) current.outageNotified = true;
  await current.save();
  if (notify) {
    try {
      await browser.notifications.create(`urs-down-${current.id}`, {
        type: 'basic',
        title: 'Update Scanner: website still down',
        iconUrl: 'images/updatescanner_48.png',
        message: `${current.title}\n${current.outageError}\nStill unavailable after three hours.`,
      });
    } catch (notificationError) {
      __.log(`Unable to show website outage notification: ${notificationError}`);
    }
  }
}

export async function scanPage(page) {
  // Don't scan if the data structures aren't yet updated to the latest version
  if (!(await __.isUpToDate())) {
    return false;
  }
  if (!page) {
    return false;
  }
  __.log(`Scanning "${page.title}"...`);
  __.log(
    `SCAN STATE id=${page.id} mode=${page.scanMode} locked=${page.scanModeLocked === true} ` +
    `standardModeVerified=${page.standardModeVerified} dynamicModeVerified=${page.dynamicModeVerified}`,
  );
  try {
    // URS_AUTOMATIC_ISOLATED_V2: Only settings-selected Automatic uses this path.
    // Manual Standard, Dynamic, Popup and locked scans remain the v5.3.0.83 path.
    if (page.scanModeAuto === true && page.scanModeLocked !== true) {
      return await runAutomaticScan(page, processHtml, async () => {
        const candidate = await fetchStandardWithDeadline(page, 10000);
        if (isJsRenderedContent(candidate)) throw new Error('Standard needs JavaScript rendering');
        return candidate;
      }, assertNotOutagePage);
    }
    let html;
    let usedRenderedFetch = false;
    // A locked page never changes scan type for any reason, and does not even
    // try another kind of scan when one fails.
    const modeLocked = page.scanModeLocked === true;
    // Automatic works out the best scan mode ONCE (on the first scan after it
    // is chosen, reset or created) and then keeps it, so a site that is down
    // for maintenance cannot push a page up to a deeper mode later. A fixed
    // mode is never checked at all. Only the user can start a new check.
    const modeFrozen =
      modeLocked || page.scanModeAuto === false || page.scanModeDetected === true;

    try {
      // Popup is the deepest render tier. Use the proven unfocused top-level
      // render window directly; there is no deeper tier to verify against.
      if (page.scanMode === "popup") {
        __.log(`Popup scan mode: using visible-render popup for "${page.title}"...`);
        html = await checkedPopupRenderedHtml(page.url, {translated: page.translatedPage === true});
        usedRenderedFetch = true;
        if (!modeFrozen) {
          const settledPage = await Page.load(page.id);
          settledPage.scanModeDetected = true;
          await settledPage.save();
          page.scanModeDetected = true;
        }
        page.lastScanMode = 'popup';
        return processHtml(page, html);
      }

      // Dynamic uses a hidden/background browser tab. Until trained, compare
      // it once against Popup using actual painted-image evidence.
      if (page.scanMode === "dynamic") {
        __.log(`Dynamic scan mode: using rendered browser fetch for "${page.title}"...`);
        // Measure the rendered capture only, excluding queue wait and comparison.
        const dynamicCaptureStartedAt = performance.now();
        const dynamicBudgetMs = await getDynamicScanBudgetMs();
        const dynamicHtml = await checkedRenderedHtml(page.url, {automatic: true, maxTotalMs: dynamicBudgetMs});
        const dynamicCaptureMs = performance.now() - dynamicCaptureStartedAt;
        html = dynamicHtml;
        usedRenderedFetch = true;

        if (page.dynamicModeVerified !== true && !modeFrozen) {
          __.log(`Dynamic mode for "${page.title}": checking Popup render capture...`);

          try {
            const popupHtml = await checkedPopupRenderedHtml(page.url, {translated: page.translatedPage === true});
            const verification = compareDynamicToPopup(dynamicHtml, popupHtml, page.url);

            __.log(`Dynamic verification for "${page.title}": painted=${verification.dynamicPaintedImages}/${verification.popupPaintedImages}; missingPainted=${verification.missingPaintedImages}; promote=${verification.promote}`);

            const updatedPage = await Page.load(page.id);

            if (verification.promote) {
              updatedPage.scanMode = "popup";
              updatedPage.dynamicModeVerified = false;
              updatedPage.scanModeDetected = true;
              await updatedPage.save();
              page.scanMode = "popup";
              page.dynamicModeVerified = false;
              page.scanModeDetected = true;
              html = popupHtml;
              __.log(`Dynamic capture for "${page.title}" missed painted visual content; page automatically switched to Popup mode.`);
            } else {
              updatedPage.dynamicModeVerified = true;
              updatedPage.scanModeDetected = true;
              await updatedPage.save();
              page.dynamicModeVerified = true;
              page.scanModeDetected = true;
              __.log(`Dynamic capture for "${page.title}" verified against Popup; remaining in Dynamic mode.`);
            }
          } catch (verificationError) {
            __.log(`Could not verify Dynamic mode for "${page.title}": ${verificationError}. Keeping Dynamic unverified so it can be checked again later.`);
          }
        }

        page.lastScanMode = page.scanMode === 'popup' ? 'popup' : 'dynamic';
        // Commit the successful scan before modifying the mode for future scans.
        const result = await processHtml(page, html);
        // Automatic mode is normally frozen after its first detection. A proven
        // performance problem is the only exception; manually selected or locked
        // modes must never be changed here. Allow a small margin over the usual
        // ~17-second Popup capture so minor timing variation cannot promote sites.
        const DYNAMIC_PROMOTION_MS = dynamicBudgetMs;
        if (page.scanMode === 'dynamic' && page.scanModeAuto === true &&
            !modeLocked && dynamicCaptureMs >= DYNAMIC_PROMOTION_MS) {
          try {
            const latest = await Page.load(page.id);
            if (latest && latest.scanMode === 'dynamic' &&
                latest.scanModeAuto === true && latest.scanModeLocked !== true) {
              latest.scanMode = 'popup';
              latest.scanModeDetected = true;
              latest.dynamicModeVerified = false;
              latest.lastScanNote = (latest.lastScanNote || '') +
                ` Automatic performance promotion: Dynamic capture took ${Math.round(dynamicCaptureMs)}ms ` +
                `(threshold ${DYNAMIC_PROMOTION_MS}ms). Future scans use Popup.`;
              await latest.save();
              page.scanMode = 'popup';
              page.scanModeDetected = true;
              __.log(`Automatic performance promotion for "${page.title}": Dynamic capture ` +
                `${Math.round(dynamicCaptureMs)}ms exceeded ${DYNAMIC_PROMOTION_MS}ms; ` +
                `next scan uses Popup. Current successful snapshot retained.`);
            }
          } catch (promotionError) {
            __.log(`Unable to persist Dynamic performance promotion for "${page.title}": ${promotionError}`);
          }
        } else {
          __.log(`Dynamic capture time for "${page.title}": ${Math.round(dynamicCaptureMs)}ms; ` +
            `automatic=${page.scanModeAuto === true}; locked=${modeLocked}.`);
        }
        return result;
      }

      // Stage 1: Standard mode starts with the normal HTTP fetch (fast path).
      // Automatic dynamic-content detection/fallback remains below.
      // URS_STANDARD_ACTIVE_RETRY_V1: manual Standard reuses its initial HTTP
      // response, then actively re-fetches incomplete HTML until the 10s
      // budget expires. Does not launch Dynamic/Popup or commit bad snapshots.
      const standardStartedAt = Date.now();
      html = await fetchStandardWithDeadline(page, 10000);
      // URS_MANUAL_STANDARD_INCOMPLETE_GUARD_V1: A successful HTTP response
      // alone does not mean the page was captured. Never commit an empty
      // JS-hydrated gallery or mistake it for "0 new changes". Manual remains
      // manual: no Dynamic or Popup fallback and no change to saved mode.
      if (page.scanModeAuto !== true || modeLocked) {
        let standardReport = inspectAutomaticCapture(html, page.url, {standard: true});
        let standardAttempts = 1;
        __.log(`MANUAL STANDARD COVERAGE attempt ${standardAttempts}: ${JSON.stringify(standardReport)}`);
        // A fast HTTP response is not a completed gallery scan. Retest the
        // original Standard HTTP path during its verification window, without
        // switching engines or ever storing a rejected candidate.
        while (!standardReport.ok && Date.now() - standardStartedAt < 9300 && standardAttempts < 7) {
          const remaining = 10000 - (Date.now() - standardStartedAt);
          if (remaining < 650) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(1400, Math.max(0, remaining - 500))));
          const left = 10000 - (Date.now() - standardStartedAt);
          if (left < 400) break;
          standardAttempts++;
          try {
            const nextHtml = await fetchStandardWithDeadline(page, Math.max(200, left - 100));
            const nextReport = inspectAutomaticCapture(nextHtml, page.url, {standard: true});
            __.log(`MANUAL STANDARD COVERAGE attempt ${standardAttempts}: ${JSON.stringify(nextReport)}`);
            if (nextReport.ok) {
              html = nextHtml;
              standardReport = nextReport;
              break;
            }
            standardReport = nextReport;
          } catch (retryError) {
            __.log(`MANUAL STANDARD retry ${standardAttempts} failed: ${retryError}`);
          }
        }
        __.log(`MANUAL STANDARD VERIFICATION: attempts=${standardAttempts}; elapsed=${Date.now() - standardStartedAt}ms; accepted=${standardReport.ok}`);
        if (!standardReport.ok) {
          __.log(`MANUAL STANDARD INCOMPLETE for "${page.title}": ${standardReport.reason}; ` +
            `saved snapshot preserved; no Dynamic/Popup fallback.`);
          return null;
        }
      }

      // If Standard has never been verified for this page, compare one real
      // rendered capture against the normal HTTP result. This training pass
      // happens only once unless the user changes the URL or switches back
      // from Dynamic to Standard.
      // UPDATESCAN_VERIFY_STANDARD_ONCE_V1
      // A Standard mode picked by hand (not locked) gets the same quick look
      // once, but only to report what it finds: the mode never changes.
      const checkOnly = false; // Manual Standard: no extra Dynamic verification pass.
      if (page.standardModeVerified !== true && (!modeFrozen || checkOnly)) {
        __.log(`Standard mode for "${page.title}": checking rendered capture...`);

        try {
          // A quick look is enough to tell whether Standard misses anything.
          const report = {};
          let renderedHtml = await checkedRenderedHtml(
            page.url, {quick: true, standardHtml: html, report});
          const verification = compareStandardToRendered(
            html,
            renderedHtml,
            page.url,
          );

          // The plain Standard HTML must also LOOK like the page. If shown the
          // way it is saved (no scripts) it has far fewer visible words than
          // the live page, for example only a header while the posts stay
          // hidden until scripts reveal them, it is an incomplete page and
          // Standard is not enough.
          const fewerWords =
            Number.isFinite(report.liveWords) && Number.isFinite(report.plainWords) &&
            report.liveWords >= 40 &&
            report.plainWords < report.liveWords * 0.6 &&
            report.liveWords - report.plainWords >= 25;
          // Not even one page: the visible content stops before the bottom of a
          // window and has only a few words, for example just a header and menu
          // because the rest is built by scripts from data after the page loads.
          const lessThanOnePage =
            Number.isFinite(report.plainBottom) && Number.isFinite(report.viewport) &&
            report.viewport > 0 &&
            report.plainBottom < report.viewport * 0.9 &&
            report.plainWords < 150;
          // Most of the page's own text is in the HTML but invisible (opacity 0)
          // until the site's scripts reveal it, so the saved page would look empty.
          const hiddenUntilScripts =
            Number.isFinite(report.plainTransparentWords) &&
            report.plainTransparentWords >= 100 &&
            report.plainWords < report.plainTransparentWords * 0.4;
          // Loading placeholders (shimmering grey bars, like the commit details on
          // a GitHub page) are only noted in the log: when the page's real text
          // is there, they are decoration and Standard is enough. If real text is
          // missing, the word-count rules above catch it.
          if (fewerWords || lessThanOnePage || hiddenUntilScripts) {
            verification.promote = true;
            __.log(
              hiddenUntilScripts ?
                `Standard HTML for "${page.title}" keeps ${report.plainTransparentWords} of its words invisible ` +
                `(only ${report.plainWords} show) until scripts run; an incomplete page, needs a deeper scan mode.` :
              lessThanOnePage ?
                `Standard HTML for "${page.title}" is less than one page (its content stops at ` +
                `${report.plainBottom}px of a ${report.viewport}px window, ${report.plainWords} words); ` +
                `an incomplete page, needs a deeper scan mode.` :
                `Standard HTML for "${page.title}" would show only ${report.plainWords} of ` +
                `${report.liveWords} visible words (an incomplete page); needs a deeper scan mode.`,
            );
          }

          if (checkOnly && verification.promote) {
            __.log(
              `Standard was chosen by hand for "${page.title}", so it stays Standard although the page ` +
              `looks incomplete in it. Choose Automatic, Dynamic or Popup to capture the rest.`,
            );
            verification.promote = false;
          }

          __.log(
            `Standard verification for "${page.title}": ` +
            `missingText=${verification.missingTextWords}/${verification.renderedTextWords}; ` +
            `missingImages=${verification.missingImages}/${verification.renderedImages}; ` +
            `dynamicWidget=${verification.dynamicWidget}; ` +
            `widgetSignals=${verification.widgetSignals}; ` +
            `promote=${verification.promote}`,
          );

          const updatedPage = await Page.load(page.id);

            if (verification.promote) {
              updatedPage.scanMode = "dynamic";
              updatedPage.dynamicModeVerified = false;
              page.scanMode = "dynamic";
              page.dynamicModeVerified = false;
              // Standard is not enough, so this scan needs a full-quality
              // Dynamic capture, not just the quick look.
              renderedHtml = await checkedRenderedHtml(page.url);
              html = renderedHtml;
              usedRenderedFetch = true;

              __.log(
                `Standard capture for "${page.title}" missed meaningful rendered content; ` +
                `testing Dynamic against Popup in the same scan.`,
              );

              try {
                const popupHtml = await checkedPopupRenderedHtml(page.url, {translated: page.translatedPage === true});
                const dynamicVerification = compareDynamicToPopup(
                  renderedHtml,
                  popupHtml,
                  page.url,
                );

                __.log(
                  `Dynamic verification for "${page.title}": ` +
                  `painted=${dynamicVerification.dynamicPaintedImages}/${dynamicVerification.popupPaintedImages}; ` +
                  `missingPainted=${dynamicVerification.missingPaintedImages}; ` +
                  `promote=${dynamicVerification.promote}`,
                );

                if (dynamicVerification.promote) {
                  updatedPage.scanMode = "popup";
                  updatedPage.dynamicModeVerified = false;
                  updatedPage.scanModeDetected = true;
                  page.scanMode = "popup";
                  page.dynamicModeVerified = false;
                  page.scanModeDetected = true;
                  html = popupHtml;
                  __.log(
                    `Dynamic capture for "${page.title}" missed painted visual content; ` +
                    `page automatically switched to Popup mode in the same scan.`,
                  );
                } else {
                  updatedPage.dynamicModeVerified = true;
                  updatedPage.scanModeDetected = true;
                  page.dynamicModeVerified = true;
                  page.scanModeDetected = true;
                  __.log(
                    `Dynamic capture for "${page.title}" verified against Popup; ` +
                    `page automatically switched to Dynamic mode.`,
                  );
                }
              } catch (dynamicVerificationError) {
                __.log(
                  `Could not verify Dynamic mode for "${page.title}": ${dynamicVerificationError}. ` +
                  `Keeping Dynamic unverified so it can be checked again later.`,
                );
              }

              await updatedPage.save();
          } else {
            updatedPage.standardModeVerified = true;
            updatedPage.scanModeDetected = true;
            await updatedPage.save();
            page.standardModeVerified = true;
            page.scanModeDetected = true;
            __.log(`Standard capture for "${page.title}" verified; future scans use the Standard fast path.`);
          }
        } catch (verificationError) {
          __.log(
            `Could not verify Standard mode for "${page.title}": ${verificationError}. ` +
            `Keeping Standard unverified so it can be checked again later.`,
          );
        }
      }

      // Existing lightweight fallback for obviously empty/JS-only responses.
      if (!usedRenderedFetch && !modeFrozen && isJsRenderedContent(html)) {
        __.log(`Page "${page.title}" appears to need JavaScript rendering, trying rendered fetch...`);
        html = await checkedRenderedHtml(page.url, {automatic: true, maxTotalMs: 15000});
        usedRenderedFetch = true;

        const updatedPage = await Page.load(page.id);
        updatedPage.scanMode = "dynamic";
        await updatedPage.save();
        page.scanMode = "dynamic";

        __.log(`Page "${page.title}" automatically switched to Dynamic mode.`);
      }
    } catch (fetchError) {
      // A server outage must not trigger automatic mode promotion.
      if (fetchError.outageReason) throw fetchError;
      // A locked page runs exactly as its scan mode says: report the failure
      // instead of quietly trying a different kind of scan.
      if (modeLocked || page.scanModeAuto === false) {
        throw fetchError;
      }
      // Automatic, still working out the best mode: a plain fetch that is
      // turned away (HTTP 403 / Cloudflare challenge) can never be Standard, so
      // move on to Dynamic and let it be checked against Popup right now.
      // (An error from a site that is just down or busy changes nothing.)
      if (fetchError.blocked && !modeFrozen && page.scanMode === 'standard') {
        const blockedPage = await Page.load(page.id);
        blockedPage.scanMode = 'dynamic';
        blockedPage.standardModeVerified = false;
        blockedPage.dynamicModeVerified = false;
        await blockedPage.save();
        page.scanMode = 'dynamic';
        page.standardModeVerified = false;
        page.dynamicModeVerified = false;
        __.log(`Standard fetch for "${page.title}" was turned away (${fetchError.message}); switching to Dynamic and checking it against Popup.`);
        return await scanPage(page);
      }
      // Stage 2: Fallback to rendered browser tab
      __.log(`Normal fetch failed for "${page.title}" (${fetchError.message}), trying rendered fetch...`);
      html = await checkedRenderedHtml(page.url, {automatic: true, maxTotalMs: 15000});
      usedRenderedFetch = true;
    }

    // Which mode really did this scan (a failed fetch or a promotion in this scan
    // means a rendered scan, whatever the setting said when the scan began).
    page.lastScanMode = usedRenderedFetch ?
      (page.scanMode === 'popup' ? 'popup' : 'dynamic') : 'standard';
    // For rendered fetch, encoding is already UTF-8 from the DOM
    // Skip the encoding detection/conversion that getHtmlFromResponse does
    return processHtml(page, html);
  } catch (error) {
    __.log(`Could not scan "${page.title}": ${error}`);
    // Only save if the page still exists
    await recordScanFailure(page, error);
  }
  return false;
}

/**
 * Heuristic to detect if HTML content is effectively empty and likely
 * requires JavaScript to render meaningful content.
 *
 * @param {string} html - Raw HTML string.
 * @returns {boolean} True if the content appears to need JS rendering.
 */
function isJsRenderedContent(html) {
  if (!html || html.trim().length === 0) {
    return true;
  }

  // Strip scripts, styles, tags, and whitespace to get visible text
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/gi, '')
    .replace(/\s+/g, '')
    .trim();

  // If less than 100 characters of visible text, the page likely needs JS
  if (visibleText.length < 100) {
    return true;
  }

  return false;
}


/**
 * Compare what the normal HTTP fetch captured with a real rendered snapshot.
 * The comparison intentionally ignores scripts/styles and obvious advertising
 * containers. Promotion is based on meaningful text or image content that is
 * present after rendering but absent from the Standard result.
 */
function compareStandardToRendered(standardHtml, renderedHtml, pageUrl) {
  const standard = buildCaptureProfile(standardHtml, pageUrl);
  const rendered = buildCaptureProfile(renderedHtml, pageUrl);

  const missingText = [...rendered.words].filter(word =>
    !standard.words.has(word));
  const missingImages = [...rendered.images].filter(image =>
    !standard.images.has(image));

  const renderedTextWords = rendered.words.size;
  const renderedImages = rendered.images.size;

  const missingTextRatio =
    renderedTextWords > 0 ? missingText.length / renderedTextWords : 0;
  const missingImageRatio =
    renderedImages > 0 ? missingImages.length / renderedImages : 0;

  // Require a meaningful gap, not tiny animation/widget noise.
  const textIncomplete =
    missingText.length >= 25 && missingTextRatio >= 0.08;

  const imageIncomplete =
    missingImages.length >= 2 && missingImageRatio >= 0.15;

  // A page with a meaningful JS-driven slider/carousel/slideshow cannot be
  // faithfully represented by the raw Standard response even when all of its
  // text and image URLs already exist in the HTML. Treat that as Dynamic.
  const dynamicWidget =
    standard.dynamicWidget || rendered.dynamicWidget;
  const widgetSignals = Math.max(
    standard.widgetSignals,
    rendered.widgetSignals,
  );

  return {
    promote: textIncomplete || imageIncomplete || dynamicWidget,
    missingTextWords: missingText.length,
    renderedTextWords,
    missingImages: missingImages.length,
    renderedImages,
    dynamicWidget,
    widgetSignals,
  };
}

function compareDynamicToPopup(dynamicHtml, popupHtml, pageUrl) {
  // UPDATESCAN_DYNAMIC_IMAGE_COMPLETENESS_V1
  const dynamic = buildCaptureProfile(dynamicHtml, pageUrl);
  const popup = buildCaptureProfile(popupHtml, pageUrl);
  const missingPaintedImages = [...popup.paintedImages].filter(image =>
    !dynamic.paintedImages.has(image));
  const missingImages = [...popup.images].filter(image =>
    !dynamic.images.has(image));
  const missingImageRatio = popup.images.size ?
    missingImages.length / popup.images.size : 0;
  const imageIncomplete =
    missingImages.length >= 2 && missingImageRatio >= 0.15;

  __.log(
    `Dynamic image completeness: images=${dynamic.images.size}/${popup.images.size}; ` +
    `missing=${missingImages.length}; incomplete=${imageIncomplete}`,
  );

  return {
    promote: missingPaintedImages.length >= 1 || imageIncomplete,
    missingPaintedImages: missingPaintedImages.length,
    dynamicPaintedImages: dynamic.paintedImages.size,
    popupPaintedImages: popup.paintedImages.size,
    missingPaintedImageUrls: missingPaintedImages,
    missingImages: missingImages.length,
  };
}

function buildCaptureProfile(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");

  // Look for generic evidence of a JS-managed visual widget before scripts
  // are removed from the comparison profile. This is intentionally based on
  // semantic HTML/data/ARIA/script signals rather than a specific website.
  const widgetToken =
    /(^|[-_:./\\s])(slide|slides|slider|slideshow|carousel|swiper|splide|slick|flickity|glide)([-_:./\\s]|$)/i;

  let widgetSignals = 0;

  [...doc.querySelectorAll("*")].forEach(el => {
    let signalText =
      `${el.id || ""} ` +
      `${typeof el.className === "string" ? el.className : ""} ` +
      `${el.getAttribute("role") || ""} ` +
      `${el.getAttribute("aria-roledescription") || ""}`;

    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith("data-") ||
          attr.name.startsWith("aria-")) {
        signalText += ` ${attr.name} ${attr.value}`;
      }
    }

    if (widgetToken.test(signalText)) {
      widgetSignals++;
    }
  });

  const scriptWidgetSignal = [...doc.querySelectorAll("script")].some(script =>
    widgetToken.test(
      `${script.getAttribute("src") || ""} ${script.textContent || ""}`,
    ));

  if (scriptWidgetSignal) {
    widgetSignals++;
  }

  const widgetMediaCount =
    doc.querySelectorAll("img, picture, video, canvas").length;

  const dynamicWidget =
    widgetSignals >= 3 ||
    (widgetSignals >= 1 && scriptWidgetSignal && widgetMediaCount >= 3);

  doc.querySelectorAll("script, style, noscript, template").forEach(node =>
    node.remove());

  const adPattern =
    /(^|[-_\s])(ad|ads|advert|advertisement|adslot|ad-slot|sponsor|sponsored|doubleclick|adsense)([-_\s]|$)/i;

  [...doc.querySelectorAll("*")].forEach(el => {
    const label =
      `${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`;
    if (adPattern.test(label)) {
      el.remove();
    }
  });

  const words = new Set(
    (doc.body ? doc.body.textContent : "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(word => word.length >= 3),
  );

  const images = new Set();
  doc.querySelectorAll("img").forEach(img => {
    const src =
      img.getAttribute("data-updatescan-original-src") ||
      img.getAttribute("src") ||
      "";

    if (!src || src.startsWith("data:") || src.startsWith("blob:")) {
      return;
    }

    try {
      const url = new URL(src, pageUrl);
      url.hash = "";
      images.add(url.href);
    } catch (e) {}
  });

  const paintedImages = new Set();
  doc.querySelectorAll('img[data-updatescan-painted-freeze="1"]').forEach(img => {
    const src =
      img.getAttribute("data-updatescan-original-src") ||
      img.getAttribute("src") ||
      "";

    if (!src || src.startsWith("data:") || src.startsWith("blob:")) {
      return;
    }

    try {
      const url = new URL(src, pageUrl);
      url.hash = "";
      paintedImages.add(url.href);
    } catch (e) {}
  });

  return {
    words,
    images,
    paintedImages,
    dynamicWidget,
    widgetSignals,
  };
}

/**
 * Given an HTTP Response, extract the HTML and apply character encoding.
 * If the page encoding attribute is not set, autodetect it and update the page.
 *
 * @param {Response} response - HTTP response.
 * @param {Page} page - Page object associated with the scan.
 *
 * @returns {string} HTML page content.
 */
async function getHtmlFromResponse(response, page) {
  // This is probably faster for the most common case (utf-8)
  if (page.encoding === 'utf-8') {
    return await response.text();
  }

  const buffer = await response.arrayBuffer();

  if (page.encoding == null || page.encoding === 'auto') {
    const rawHtml = __.applyEncoding(buffer, 'utf-8');
    const updatedPage = await Page.load(page.id);
    updatedPage.encoding = __.detectEncoding(response.headers, rawHtml);
    await updatedPage.save();
  }
  return __.applyEncoding(buffer, page.encoding);
}

/**
 * Load the "NEW" HTML from storage, compare it with the the scanned HTML,
 * update the page state and update the HTML storage as necessary. Returns
 * without waiting for the save operations to complete.
 * Note that the "NEW" HTML is used for comparison - this is the HTML that was
 * downloaded during the most recent scan. This is the simplest and most
 * resource-efficient approach.
 *
 * @param {Page} page - Page object to update.
 * @param {string} scannedHtml - HTML to process.
 *
 * @returns {boolean} True if a new major change is detected.
 */
async function processHtml(page, scannedHtml) {
  assertNotOutagePage(scannedHtml);
  // Do nothing if the page no longer exists
  const existsInStorage = await page.existsInStorage();
  if (!existsInStorage) {
    return false;
  }

  await restoreLastValidSnapshot(page);
  const prevHtml = await PageStore.loadHtml(page.id, PageStore.htmlTypes.NEW);

  return processHtmlWithConditions(page, scannedHtml, prevHtml);
}

/**
 * Processes HTML with selectors specified in page settings. If selectors
 * do not exist or page was not scanned yet standard update is called.
 *
 * @param {Page} page - Page object to update.
 * @param {string} scanHtml - HTML to process.
 * @param {string} prevHtml - Previous HTML.
 *
 * @returns {boolean} True if a new major change is detected.
 */
async function processHtmlWithConditions(page, scanHtml, prevHtml) {
  if (page.selectors && prevHtml != null) {
    const scanParts = await __.matchHtmlWithSelector(scanHtml, page.selectors);
    const prevParts = await __.matchHtmlWithSelector(prevHtml, page.selectors);
    return updatePageState(
      page,
      new ContentData(prevHtml, prevParts),
      new ContentData(scanHtml, scanParts),
    );
  } else {
    return updatePageState(
      page,
      new ContentData(prevHtml, null),
      new ContentData(scanHtml, null),
    );
  }
}

/**
 * Compare the scanned HTML with the "NEW" HTML from storage, update the page
 * state and save the HTML to storage. The method returns without waiting for
 * the save operations to complete.
 *
 * @param {Page} page - Page object to update.
 * @param {ContentData} prevHtmlData - HTML from storage.
 * @param {ContentData} scannedHtmlData - Scanned HTML to process.
 *
 * @returns {boolean} True if a new major change is detected.
 */
async function updatePageState(page, prevHtmlData, scannedHtmlData) {
  const updatedPage = await Page.load(page.id);

  let changeType = getChanges(
    prevHtmlData,
    scannedHtmlData,
    updatedPage,
  );
  const firstVerdict = changeType;

  // The Changes view highlights only visible text that really changed. Count
  // those characters: if they are within the threshold, whatever else differed
  // (hidden parts, markup, removed slides) is not a change the user can see.
  let highlightedSize = null;
  if (changeType === changeEnum.MAJOR_CHANGE && !updatedPage.selectors &&
      !updatedPage.requireExactMatchCount) {
    try {
      const result = diffWithSummary(
        updatedPage, prevHtmlData.html, scannedHtmlData.html);
      highlightedSize = result.summary.characters;
      if (highlightedSize <= updatedPage.changeThreshold) {
        changeType = changeEnum.MINOR_CHANGE;
      }
    } catch (error) {
      __.log(`Could not count highlighted changes: ${error}`);
    }
  }

  // Remember how big this change was, so the page settings can suggest a
  // threshold. Measuring never affects the scan result.
  if (changeType === changeEnum.MAJOR_CHANGE ||
      changeType === changeEnum.MINOR_CHANGE) {
    try {
      const size = highlightedSize != null ? highlightedSize :
        getChangeSize(prevHtmlData, scannedHtmlData, updatedPage);
      if (size > 0) {
        updatedPage.recordChangeSize(size);
      }
    } catch (error) {
      __.log(`Could not measure the size of a change: ${error}`);
    }
  }

    if (changeType === changeEnum.MAJOR_CHANGE) {
      if (!updatedPage.isChanged()) {
        await PageStore
          .saveHtml(updatedPage.id, PageStore.htmlTypes.OLD, prevHtmlData.html);
        updatedPage.oldScanTime = updatedPage.newScanTime;
      }
      await PageStore
        .saveHtml(updatedPage.id, PageStore.htmlTypes.NEW, scannedHtmlData.html);
      updatedPage.state = Page.stateEnum.CHANGED;
    } else {
      // If the previous change has already been acknowledged, advance OLD to
      // the last accepted NEW snapshot. While still CHANGED, preserve OLD as
      // the comparison baseline until the user views/acknowledges the change.
      if (!updatedPage.isChanged()) {
        await PageStore
          .saveHtml(updatedPage.id, PageStore.htmlTypes.OLD, prevHtmlData.html);
        updatedPage.oldScanTime = updatedPage.newScanTime;
        updatedPage.state = Page.stateEnum.NO_CHANGE;
      }
      await PageStore
        .saveHtml(updatedPage.id, PageStore.htmlTypes.NEW, scannedHtmlData.html);
    }

  updatedPage.outageFirstAt = null;
  updatedPage.outageCheckAt = null;
  updatedPage.outageNotified = false;
  updatedPage.outageError = '';
  // A valid capture clears gray/red outage status, even if there was no change.
  if (updatedPage.state === Page.stateEnum.ERROR ||
      updatedPage.state === Page.stateEnum.DOWN) {
    updatedPage.state = Page.stateEnum.NO_CHANGE;
  }
  updatedPage.newScanTime = Date.now();
  if (page.lastScanMode) {
    updatedPage.lastScanMode = page.lastScanMode;
  }
  updatedPage.lastScanNote = `Last scan (${new Date().toLocaleString()}): ` +
    `text comparison said ${firstVerdict}` +
    (highlightedSize != null ?
      `; highlighted visible text ${highlightedSize} characters vs threshold ` +
      `${updatedPage.changeThreshold}` : '') +
    `; result ${changeType}, page is ${updatedPage.state}.`;

  await updatedPage.save();
  return changeType === changeEnum.MAJOR_CHANGE;
}
