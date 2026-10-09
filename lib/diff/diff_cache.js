// The cached output is presentation-only. Scan comparisons always use OLD/NEW
// raw snapshots, never this static HTML.
const CACHE_TYPE = 'diff-cache';
const CACHE_VERSION = 2;

export async function loadOrRenderDiff(page, storage, render) {
  const key = JSON.stringify([
    CACHE_VERSION, page.url, page.oldScanTime, page.newScanTime,
  ]);
  try {
    const cached = JSON.parse(await storage.load(page.id, CACHE_TYPE));
    if (cached.key === key && typeof cached.html === 'string') {
      return cached.html;
    }
  } catch (e) {
    // Missing/invalid cache: generate it from the stored scan snapshots.
  }

  const html = await render();
  try {
    await storage.save(page.id, CACHE_TYPE, JSON.stringify({key, html}));
  } catch (e) {
    // Storage failure should not prevent viewing the diff.
  }
  return html;
}
