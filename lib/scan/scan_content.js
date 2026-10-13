import {log} from '/lib/util/log.js';
import {isMajorChange, changeSize} from './fuzzy.js';
import {Page} from '../page/page.js';

/**
 * Enumeration indicating the similarity of two HTML strings.
 *
 * @readonly
 * @enum {string}
 */
export const changeEnum = {
  NEW_CONTENT: 'new_content',
  NO_CHANGE: 'no_change',
  MAJOR_CHANGE: 'major_change',
  MINOR_CHANGE: 'minor_change',
};

export const __ = {
  log: (...args) => log(...args),
  isMajorChange: (...args) => isMajorChange(...args),
  changeEnum: changeEnum,
  stripHtml: stripHtml,
  getChanges: getChanges,
  getIteratorFunction: getIteratorFunction,
};

/**
 * Content data with previously prepared and chopped HTML.
 *
 * @property {string} html - Page HTML.
 * @property {?Array} parts - HTML split.
 */
export class ContentData {
  /**
   * @param {string} html - Page HTML.
   * @param {?Array} parts - HTML split.
   */
  constructor(html, parts = null) {
    this.html = html || '';
    this.parts = parts || null;
  }

}

/**
 * Detects changes based on two HTML data and page.
 *
 * @param {ContentData} prevData - Data for previous HTML.
 * @param {ContentData} scannedData - Data for scanned HTML.
 * @param {Page} page - Page.
 *
 * @returns {string|changeEnum} ChangeEnum string indicating how similar the
 * two HTML strings are.
 */
export function getChanges(prevData, scannedData, page) {
  if (prevData.html == null || prevData.html === '') {
    return changeEnum.NEW_CONTENT;
  }

  if (page.requireExactMatchCount) {
    const countChange = getCountChange(prevData, scannedData);
    if (countChange === changeEnum.MAJOR_CHANGE) {
      return countChange;
    }
  }

  if (prevData.html === scannedData.html) {
    return changeEnum.NO_CHANGE;
  }

  if (marksDiffer(prevData.html, scannedData.html)) {
    return changeEnum.NO_CHANGE;
  }

  const contentModeEnum = Page.contentModeEnum;
  const contentMode = page.contentMode || contentModeEnum.TEXT;
  if (contentMode === contentModeEnum.IGNORE) {
    return changeEnum.NO_CHANGE;
  }

  const prevParts = prevData.parts || [prevData.html];
  const scannedParts = scannedData.parts || [scannedData.html];

  const ignoreTags = contentMode !== contentModeEnum.HTML;

  const htmlChange = getHTMLChange(page, prevParts, scannedParts, ignoreTags);

  // If no change was detected in parts, just return minor change because we
  // already know there was a change somewhere in the html
  if (htmlChange === changeEnum.NO_CHANGE) {
    return getChangeInStrippedHtml(page, prevData.html, scannedData.html);
  } else {
    return htmlChange;
  }
}

/**
 * Measures the biggest change between the previous and the scanned content, in
 * the same units as the Change Threshold setting: the smallest threshold that
 * would have ignored every difference. Uses the page's own number and tag
 * handling, so what is measured is what the scan would actually compare.
 *
 * @param {ContentData} prevData - Data for previous HTML.
 * @param {ContentData} scannedData - Data for scanned HTML.
 * @param {Page} page - Page.
 *
 * @returns {?number} Size in characters (0 when nothing differs after
 * stripping), or null when there is nothing to compare with.
 */
export function getChangeSize(prevData, scannedData, page) {
  if (prevData.html == null || prevData.html === '') {
    return null;
  }

  if (marksDiffer(prevData.html, scannedData.html)) {
    return 0;
  }

  const contentModeEnum = Page.contentModeEnum;
  const contentMode = page.contentMode || contentModeEnum.TEXT;
  if (contentMode === contentModeEnum.IGNORE) {
    return 0;
  }
  const ignoreTags = contentMode !== contentModeEnum.HTML;
  const prevParts = prevData.parts || [prevData.html];
  const scannedParts = scannedData.parts || [scannedData.html];

  let largest = 0;
  const length = Math.min(prevParts.length, scannedParts.length);
  for (let i = 0; i < length; i++) {
    const prevStrip = stripHtml(prevParts[i], page.ignoreNumbers, ignoreTags);
    const scanStrip = stripHtml(scannedParts[i], page.ignoreNumbers, ignoreTags);
    if (prevStrip !== scanStrip) {
      largest = Math.max(largest, changeSize(prevStrip || '', scanStrip || ''));
    }
  }
  return largest;
}

/**
 * Returns true if prev and scanned HTML are not equal after stripping.
 *
 * @param {Page} page - Page.
 * @param {string} prevHtml - Previous HTML.
 * @param {string} scannedHtml - Scanned HTML.
 * @returns {changeEnum} True if change is detected.
 */
function getChangeInStrippedHtml(page, prevHtml, scannedHtml) {
  const ignoreTags = page.contentMode !== Page.contentModeEnum.HTML;
  const prevStrip = stripHtml(
    prevHtml,
    page.ignoreNumbers,
    ignoreTags,
  );
  const scanStrip = stripHtml(
    scannedHtml,
    page.ignoreNumbers,
    ignoreTags,
  );

  return prevStrip !== scanStrip ?
    changeEnum.MINOR_CHANGE :
    changeEnum.NO_CHANGE;
}

/**
 * Detects change in data part count.
 *
 * @param {ContentData} prevData - Data for previous HTML.
 * @param {ContentData} scannedData - Data for scanned HTML.
 * @returns {changeEnum} - ChangeEnum string indicating how similar the
 * two HTML strings are.
 */
function getCountChange(prevData, scannedData) {
  const prevParts = prevData.parts;
  const scannedParts = scannedData.parts;
  if (prevParts == null) {
    return (scannedParts != null) ?
      changeEnum.MAJOR_CHANGE :
      changeEnum.NO_CHANGE;
  } else if (scannedParts == null) {
    return changeEnum.MAJOR_CHANGE;
  } else {
    return (scannedParts.length !== prevParts.length) ?
      changeEnum.MAJOR_CHANGE :
      changeEnum.NO_CHANGE;
  }
}

/**
 * Detects change in HTML content.
 *
 * @param {Page} page - Page.
 *
 * @param {string[]} prevParts - Parts for previous HTML.
 * @param {string[]} scannedParts - Parts for scanned HTML.
 * @param {boolean} ignoreTags - Ignore tags.
 * @returns {changeEnum} - ChangeEnum string indicating how similar the
 * two HTML strings are.
 */
function getHTMLChange(page, prevParts, scannedParts, ignoreTags) {
  let maxChangeDetected = changeEnum.NO_CHANGE;
  const iterator = getIteratorFunction(page, prevParts, scannedParts);

  for (const it of iterator) {
    const prevStrip = stripHtml(
      prevParts[it.prevIndex],
      page.ignoreNumbers,
      ignoreTags,
    );
    const scanStrip = stripHtml(
      scannedParts[it.scannedIndex],
      page.ignoreNumbers,
      ignoreTags,
    );

    if (prevStrip !== scanStrip) {
      if (__.isMajorChange(prevStrip, scanStrip, page.changeThreshold)) {
        maxChangeDetected = changeEnum.MAJOR_CHANGE;
        break;
      } else {
        maxChangeDetected = changeEnum.MINOR_CHANGE;
      }
    }
  }

  return maxChangeDetected;
}

/**
 * Returns iterator function as specified by pages setting of match mode.
 *
 * @param {Page} page - Page.
 * @param {Array} prevParts - Parts from previous scan.
 * @param {Array} scannedParts - Parts from this scan.
 * @returns {Generator} Function for iterating over
 *   parts.
 */
function getIteratorFunction(page, prevParts, scannedParts) {
  const iteratorFunction = function* (prevParts, scannedParts) {
    const length = Math.min(prevParts.length, scannedParts.length);
    for (let i = 0; i < length; i++) {
      yield {
        prevIndex: i,
        scannedIndex: i,
      };
    }
  };

  /**
   * This callback is displayed as part of the Requester class.
   *
   * @generator
   * @function iteratorFunction
   *
   * @param {Array} prevParts - Previous parts.
   * @param {Array} scannedParts - Scanned parts.
   * @param {number} length - Integer representing length.
   * @yields {{prevIndex: number, scannedIndex: number}}
   */
  return iteratorFunction(prevParts, scannedParts);
}

/**
 * Strips whitespace, (most) scripts, tags and (optionally) numbers from the
 * input HTML.
 *
 * @param {?string} inHtml - HTML to strip.
 * @param {boolean} ignoreNumbers - True if numbers should be stripped.
 * @param {boolean} ignoreTags - True if tags should be stripped.
 *
 * @returns {object} Object containing the updated prevHtml and scannedHtml.
 */
function stripHtml(inHtml, ignoreNumbers, ignoreTags) {
  let html = inHtml;
  if (html == null) return null;

  // Only what is showing counts: leave out the parts the scan saw were hidden,
  // and (when comparing text) the page head, <noscript> and <template> blocks.
  html = dropHiddenParts(html);
  if (ignoreTags) {
    html = stripMetadata(html);
  }

  // for proper number stripping, whitespaces need to be intact.
  if (ignoreNumbers) {
    html = stripNumbers(html);
  }

  html = stripScript(stripWhitespace(html));

  if (ignoreTags) {
    html = stripTags(stripStyle(html));
  }
  return html;
}

/**
 * True when only one of two snapshots was checked for hidden parts (one was saved
 * by an older version, or by a Standard scan). The unmarked one still holds the
 * text of hidden slides and menus, so comparing them would count all of that as
 * changed. Such a pair is not compared; the next scan has marks on both sides.
 *
 * @param {string} prevHtml - Previous HTML.
 * @param {string} scannedHtml - Scanned HTML.
 *
 * @returns {boolean} True if exactly one has marks.
 */
export function marksDiffer(prevHtml, scannedHtml) {
  const mark = 'data-updatescan-marked';
  return prevHtml.includes(mark) !== scannedHtml.includes(mark);
}

/**
 * Removes the parts of a rendered snapshot that were not showing when it was
 * captured (other slides of a carousel, closed menus, collapsed sections). The
 * scan marks them with data-updatescan-hidden; snapshots without marks, and
 * pages scanned in Standard mode, are returned as they are.
 *
 * @param {string} html - HTML to process.
 *
 * @returns {string} HTML without the hidden parts.
 */
export function dropHiddenParts(html) {
  if (!html.includes('data-updatescan-hidden')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('[data-updatescan-hidden="1"]')
    .forEach((element) => element.remove());
  return doc.documentElement.outerHTML;
}

/**
 * @param {string} html - HTML to process.
 *
 * @returns {string} HTML with whitespace removed.
 */
function stripWhitespace(html) {
  return html.replace(/\s+/g, '');
}

/**
 * @param {string} html - HTML to process.
 *
 * @returns {string} HTML with (most) scripts removed.
 */
function stripScript(html) {
  return html.replace(/<script.*?>.*?<\/script>/gi, '');
}

/**
 * Removes <style> blocks including their CSS text. Rendered snapshots carry the
 * whole page's CSS inlined as <style> tags; removing only the tags would leave
 * that CSS behind as if it were page text.
 *
 * @param {string} html - HTML to process.
 *
 * @returns {string} HTML with style blocks removed.
 */
function stripStyle(html) {
  return html.replace(/<style.*?>.*?<\/style>/gi, '');
}

/**
 * Removes parts of a page that are never shown as page content: the head (the
 * title and other metadata), <noscript> fallbacks and <template> blocks. The
 * title text, for example, would otherwise count as a change when a page puts
 * an unread count or timestamp in it.
 *
 * @param {string} html - HTML to process.
 *
 * @returns {string} HTML without those parts.
 */
function stripMetadata(html) {
  return html
    .replace(/<head(\s[^>]*)?>[\s\S]*?<\/head>/i, '')
    .replace(/<noscript(\s[^>]*)?>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<template(\s[^>]*)?>[\s\S]*?<\/template>/gi, '');
}

/**
 * @param {string} html - HTML to process.
 *
 * @returns {string} HTML with tags removed.
 */
function stripTags(html) {
  return html.replace(/(<([^<]+)>)/g, '');
}

/**
 * @param {string} html - HTML to process.
 *
 * @returns {string} HTML with numbers, commas and full stops removed.
 */
function stripNumbers(html) {
  return html.replace(/([0-9]+([,.]?[0-9])?)*/g, '');
}
