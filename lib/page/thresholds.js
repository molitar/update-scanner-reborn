// Change Threshold steps and the wording used to describe how big a change is.
// Shared by the page settings dialog, the Changes view and the sidebar so they
// always agree.

// Threshold steps: every 10 characters up to 200, every 20 up to 300, every 25
// up to 500, then every 100 up to 1500. Fine enough to dial a page
// in (rotating episode lists, counters that tick up) without hiding real edits.
// The top steps are for listing pages that add a batch of posts between scans.
function labelFor(chars) {
  if (chars <= 10) return 'Cosmetic';
  if (chars <= 40) return 'Tiny';
  if (chars <= 90) return 'Minor';
  if (chars <= 190) return 'Small';
  if (chars <= 300) return 'Moderate';
  if (chars <= 500) return 'Medium';
  return 'Large';
}

const STEP_SIZES = [];
for (let chars = 10; chars <= 200; chars += 10) STEP_SIZES.push(chars);
for (let chars = 220; chars <= 300; chars += 20) STEP_SIZES.push(chars);
for (let chars = 325; chars <= 500; chars += 25) STEP_SIZES.push(chars);
for (let chars = 600; chars <= 1500; chars += 100) STEP_SIZES.push(chars);

export const THRESHOLD_STEPS = STEP_SIZES.map((chars) => [chars, labelFor(chars)]);

// Changes bigger than this are reported as "over 5000" (see changeSize()).
export const MAX_MEASURED_CHANGE = 5000;

// Scans needed before a "typical" change is worked out.
export const MIN_SCANS_FOR_TYPICAL = 3;

/**
 * @param {number} size - Size of a change in characters.
 *
 * @returns {?number} The smallest threshold step that ignores a change of this
 * size, or null if it is bigger than the highest step.
 */
export function thresholdFor(size) {
  for (const [chars] of THRESHOLD_STEPS) {
    if (chars >= size) return chars;
  }
  return null;
}

/**
 * Work out what is normal for a page from the sizes of its recent changes.
 *
 * The threshold is compared with exactly these numbers, so the threshold that
 * ignores the page's usual changes is the smallest step at or above normalMax.
 * Real changes are rarer and bigger, so they sit above it.
 *
 * @param {Array<number|{size: number}>} sizes - Sizes in characters, oldest
 * first (the page's recorded changes).
 *
 * @returns {?{count: number, median: number, normalMax: number,
 * largest: number}} median is the typical change; normalMax is how big normal
 * changes get (the 80th percentile, so a few big real changes don't count); null
 * when nothing was recorded.
 */
export function typicalChange(sizes) {
  const list = (sizes || [])
    .map((entry) => Number(entry && typeof entry === 'object' ? entry.size : entry))
    .filter((size) => Number.isFinite(size) && size > 0)
    .map((size) => Math.min(size, MAX_MEASURED_CHANGE + 1))
    .sort((a, b) => a - b);
  if (list.length === 0) return null;
  const rank = list.length >= 5 ?
    Math.ceil(list.length * 0.8) - 1 : list.length - 1;
  return {
    count: list.length,
    median: list[Math.floor((list.length - 1) / 2)],
    normalMax: list[rank],
    largest: list[list.length - 1],
  };
}

/**
 * @param {number} size - Size in characters.
 *
 * @returns {string} The size for display ("1000+" when over the maximum).
 */
function show(size) {
  return size > MAX_MEASURED_CHANGE ? `${MAX_MEASURED_CHANGE}+` : String(size);
}

/**
 * Describe the change shown in the Changes view.
 *
 * @param {?number} size - Largest change in characters, 0 when nothing differs
 * once numbers/markup are stripped, null when it could not be measured.
 * @param {number} threshold - The page's Change Threshold.
 * @param {Array<number|{size: number}>} [history] - The page's recorded change
 * sizes, used to say what is typical for the page.
 *
 * @returns {?{label: string, short: string, note: string}} label for the view
 * dropdown, short for under the page title (e.g. "56 changed, 16 over the 40
 * threshold") and note for the hover text explaining it; null if there is
 * nothing to show.
 */
export function describeChange(size, threshold, history = []) {
  if (size === null || size === undefined || Number.isNaN(size)) {
    return null;
  }
  if (size === 0) {
    return {
      label: 'View Changes (nothing counted)',
      short: 'nothing counted',
      note: 'Nothing counts as a change once numbers and markup are ignored.',
    };
  }

  const thisChange = size > MAX_MEASURED_CHANGE ?
    `over ${MAX_MEASURED_CHANGE}` : String(size);

  // Short text (dropdown and the line under the title): how many characters
  // changed and how far that is over or under the threshold.
  let gap = '';
  let short = `${thisChange} changed`;
  if (threshold > 0) {
    if (size > MAX_MEASURED_CHANGE) {
      short += `, above the ${threshold} threshold`;
    } else if (size > threshold) {
      short += `, ${size - threshold} over the ${threshold} threshold`;
      gap = `${size - threshold} over`;
    } else if (size < threshold) {
      short += `, ${threshold - size} under the ${threshold} threshold`;
      gap = `${threshold - size} under`;
    } else {
      short += `, right at the ${threshold} threshold`;
      gap = 'at the limit';
    }
  } else {
    short += ', every change is reported';
  }
  const label = `View Changes (${thisChange} changed${gap ? ', ' + gap : ''})`;

  // Detail (hover text), one idea per line: 1. what happened, 2. how to read
  // the numbers, 3. what is normal for the page and what to set (once there
  // are a few scans to tell).
  const typical = typicalChange(history);
  const known = typical !== null && typical.count >= MIN_SCANS_FOR_TYPICAL;
  const highest = THRESHOLD_STEPS[THRESHOLD_STEPS.length - 1][0];

  let what = `${thisChange} characters changed.`;
  if (!(threshold > 0)) {
    what += ' Every change is reported at the current setting.';
  } else if (size > threshold) {
    what += ` That is above your threshold of ${threshold}, so it was reported.`;
    if (size > MAX_MEASURED_CHANGE) {
      // No threshold step can ignore this, so do not suggest one.
      what += ` It is bigger than the highest threshold (${highest}), so no ` +
        'setting would ignore it. A change this large usually means the page ' +
        'was rebuilt, or the two scans were captured differently (a ' +
        'different scan mode, zoom or window size). Scan again to see if it ' +
        'settles.';
    } else if (!known) {
      const needed = thresholdFor(size);
      what += ' If it is not a real change, set the threshold to ' +
        `${needed === null ? highest : needed} or higher.`;
    }
  } else {
    what += ` That is within your threshold of ${threshold}, so it was ` +
      'ignored.';
  }

  const how = threshold > 0 ?
    'How to read it: the threshold is the biggest change, in characters, ' +
    'that is ignored. A change at or below it is ignored; a bigger one is ' +
    'reported. "Over" and "under" show how far this change is past it.' :
    'How to read it: the threshold is the biggest change, in characters, ' +
    'that is ignored. It is set to 0, so nothing is ignored.';

  let normal;
  if (known) {
    normal = `Normally this page changes by about ${show(typical.median)} ` +
      `(up to ${show(typical.normalMax)}, from its last ${typical.count} ` +
      'scans).';
    if (threshold > 0 && threshold >= typical.normalMax) {
      normal += size > threshold ?
        ' This change is bigger than normal, so it is probably a real change.' :
        ` Your threshold of ${threshold} is above that, so only bigger ` +
        'changes are reported.';
    } else {
      const better = thresholdFor(typical.normalMax);
      normal += better === null ?
        ' No threshold step is high enough to ignore that.' :
        ` A threshold of ${better} ignores normal changes and still reports ` +
        `bigger ones${size > typical.normalMax ? ', such as this one' : ''}.`;
    }
  } else {
    normal = 'Scan the page a few more times to learn what is normal for it.';
  }
  return {label, short, note: [what, how, normal].join('\n')};
}

/**
 * @param {?Array<{size: number}>} changeSizes - A page's recorded change sizes,
 * oldest first.
 *
 * @returns {?string} Hover text for the sidebar, or null if none recorded.
 */
export function changeTooltip(changeSizes) {
  const typical = typicalChange(changeSizes);
  if (typical === null) return null;
  const sizes = changeSizes
    .map((entry) => Number(entry && entry.size))
    .filter((size) => Number.isFinite(size) && size > 0);
  const last = sizes[sizes.length - 1];
  if (typical.count < MIN_SCANS_FOR_TYPICAL) {
    return `Last change: ${show(last)} characters`;
  }
  return `Last change: ${show(last)} characters. Typical: ` +
    `${show(typical.median)}, normally up to ${show(typical.normalMax)} ` +
    `(last ${typical.count} scans)`;
}
