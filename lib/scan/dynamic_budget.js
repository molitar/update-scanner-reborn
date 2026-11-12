// USR1 dynamic deadline: global, shared by Automatic and Dynamic.
export const DYNAMIC_SCAN_DEFAULT_SECONDS = 25;
export const DYNAMIC_SCAN_MIN_SECONDS = 20;
export const DYNAMIC_TEST_CAPTURE_OVERHEAD_MS = 15000;
export const DYNAMIC_SCAN_MAX_SECONDS = 45;
export function clampDynamicSeconds(value) {
  if (value === null || value === undefined || value === '') return DYNAMIC_SCAN_DEFAULT_SECONDS;
  const number = Number(value);
  if (!Number.isFinite(number)) return DYNAMIC_SCAN_DEFAULT_SECONDS;
  return Math.max(DYNAMIC_SCAN_MIN_SECONDS, Math.min(DYNAMIC_SCAN_MAX_SECONDS,
    Math.round(number)));
}
export async function getDynamicScanBudgetMs() {
  try {
    const {usrDynamicScanMaxSeconds, ursDiagnosticPassCaptures} =
      await browser.storage.local.get(['usrDynamicScanMaxSeconds', 'ursDiagnosticPassCaptures']);
    // The toolbar test option "capture each Dynamic pass" takes screenshots,
    // which need time of their own: add it so the chosen limit is not eaten.
    const testOverheadMs = ursDiagnosticPassCaptures === true ? DYNAMIC_TEST_CAPTURE_OVERHEAD_MS : 0;
    return clampDynamicSeconds(usrDynamicScanMaxSeconds) * 1000 + testOverheadMs;
  } catch (_) { return DYNAMIC_SCAN_DEFAULT_SECONDS * 1000; }
}
