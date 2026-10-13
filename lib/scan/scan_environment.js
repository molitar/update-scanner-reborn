import {log} from '/lib/util/log.js';

// The same page can be captured differently depending on the browser's zoom and
// the size of the window it is rendered in (responsive pages move and repeat
// content at different widths). This module records those conditions with every
// rendered snapshot, keeps the scan zoom steady, and tells the Changes view when
// the old and new captures were taken under different conditions.

export const STAMP_NAME = 'updatescan-capture';

// Scans are taken at this zoom no matter what zoom the user has set for the
// site, so two scans are comparable. Set to null to leave the zoom alone.
export const SCAN_ZOOM = 1;

const ZOOM_TOLERANCE = 0.005;
const SIZE_TOLERANCE = 0.03;   // window sizes within 3% count as the same

/**
 * Called once the scan tab has loaded: read the zoom it inherited from the site
 * and, if it is not SCAN_ZOOM, set it for the scan. Never throws; the original
 * zoom is returned so finishScanTab() can put it back.
 *
 * @param {number} tabId - Scan tab.
 *
 * @returns {Promise<{original: ?number, changed: boolean}>} State to pass to
 * finishScanTab().
 */
export async function prepareScanTab(tabId) {
  let original = null;
  try {
    original = await browser.tabs.getZoom(tabId);
  } catch (error) {
    log(`Scan zoom: could not read the tab zoom: ${error}`);
    return {original: null, changed: false};
  }
  if (SCAN_ZOOM === null || Math.abs(original - SCAN_ZOOM) <= ZOOM_TOLERANCE) {
    log(`Scan zoom: ${Math.round(original * 100)}% (left as is)`);
    return {original, changed: false};
  }
  try {
    await browser.tabs.setZoom(tabId, SCAN_ZOOM);
    log(`Scan zoom: the site is zoomed to ${Math.round(original * 100)}%; ` +
      `scanning at ${Math.round(SCAN_ZOOM * 100)}% so scans match.`);
    return {original, changed: true};
  } catch (error) {
    log(`Scan zoom: could not set the zoom: ${error}`);
    return {original, changed: false};
  }
}

/**
 * Put the zoom back before the scan tab is closed, in case the browser stores
 * zoom per site and would otherwise leave the user's site at the scan zoom.
 *
 * @param {number} tabId - Scan tab.
 * @param {{original: ?number, changed: boolean}} state - From prepareScanTab().
 */
export async function finishScanTab(tabId, state) {
  if (!state || !state.changed || state.original === null) return;
  try {
    await browser.tabs.setZoom(tabId, state.original);
    log(`Scan zoom: restored to ${Math.round(state.original * 100)}%.`);
  } catch (error) {
    log(`Scan zoom: could not restore the zoom: ${error}`);
  }
}

/**
 * Read the conditions the page is being captured under.
 *
 * @param {number} tabId - Scan tab.
 * @param {{original: ?number, changed: boolean}} state - From prepareScanTab().
 *
 * @returns {Promise<object>} {zoom, userZoom, width, height, ratio}; missing
 * values are null.
 */
export async function readCaptureEnvironment(tabId, state) {
  const env = {zoom: null, userZoom: state ? state.original : null,
    width: null, height: null, ratio: null};
  try {
    env.zoom = await browser.tabs.getZoom(tabId);
  } catch (error) {
    // keep null
  }
  try {
    const [size] = await browser.tabs.executeScript(tabId, {
      code: '({w: window.innerWidth, h: window.innerHeight, r: window.devicePixelRatio})',
    });
    if (size) {
      env.width = size.w;
      env.height = size.h;
      env.ratio = size.r;
    }
  } catch (error) {
    // keep null
  }
  log(`Capture conditions: ${formatStamp(env)}`);
  return env;
}

/**
 * @param {object} env - Capture conditions.
 *
 * @returns {string} Text stored in the snapshot, e.g.
 * "zoom=1;userZoom=1.05;width=1503;height=912;ratio=1".
 */
export function formatStamp(env) {
  return ['zoom', 'userZoom', 'width', 'height', 'ratio']
    .filter((key) => env[key] !== null && env[key] !== undefined)
    .map((key) => `${key}=${Math.round(env[key] * 1000) / 1000}`)
    .join(';');
}

/**
 * Add the capture conditions to a snapshot as a <meta> tag (tags are ignored
 * when text is compared, so the stamp never counts as a change).
 *
 * @param {string} html - Captured HTML.
 * @param {object} env - Capture conditions.
 *
 * @returns {string} HTML with the stamp added.
 */
export function stampSnapshot(html, env) {
  const text = formatStamp(env);
  if (!text) return html;
  const tag = `<meta name="${STAMP_NAME}" content="${text}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (open) => open + tag);
  }
  return tag + html;
}

/**
 * @param {?string} html - A stored snapshot.
 *
 * @returns {?object} The capture conditions stamped into it, or null (older
 * snapshots, and pages scanned in Standard mode, have none).
 */
export function readStamp(html) {
  if (!html) return null;
  const match = html.match(
    new RegExp(`<meta name="${STAMP_NAME}" content="([^"]*)"`, 'i'));
  if (!match) return null;
  const env = {};
  for (const part of match[1].split(';')) {
    const [key, value] = part.split('=');
    const number = Number(value);
    if (key && Number.isFinite(number)) env[key] = number;
  }
  return Object.keys(env).length ? env : null;
}

/**
 * Compare how the old and the new snapshot were captured.
 *
 * @param {?object} oldEnv - From readStamp() of the old snapshot.
 * @param {?object} newEnv - From readStamp() of the new snapshot.
 *
 * @returns {?{short: string, note: string}} What differs, or null when they
 * match or one of them has no record.
 */
export function compareCaptures(oldEnv, newEnv) {
  if (!oldEnv || !newEnv) return null;
  const percent = (zoom) => `${Math.round(zoom * 100)}%`;
  const parts = [];
  const shorts = [];

  const zoomDiffers = oldEnv.zoom !== undefined && newEnv.zoom !== undefined &&
    Math.abs(oldEnv.zoom - newEnv.zoom) > ZOOM_TOLERANCE;
  if (zoomDiffers) {
    parts.push(`The old page was scanned at ${percent(oldEnv.zoom)} zoom and ` +
      `the new one at ${percent(newEnv.zoom)}.`);
    shorts.push('different zoom');
  }

  const relative = (a, b) => Math.abs(a - b) / Math.max(a, b);
  const widthDiffers = oldEnv.width !== undefined && newEnv.width !== undefined &&
    relative(oldEnv.width, newEnv.width) > SIZE_TOLERANCE;
  if (widthDiffers) {
    parts.push(`The scan window was ${Math.round(oldEnv.width)} pixels wide ` +
      `for the old page and ${Math.round(newEnv.width)} for the new one.`);
    shorts.push('different window width');
  }

  if (parts.length === 0) return null;
  return {
    short: shorts.join(' and '),
    note: parts.join(' ') + ' Pages can lay out and repeat content ' +
      'differently at different sizes, so some changes may only reflect that. ' +
      'New scans use the same zoom each time.',
  };
}
