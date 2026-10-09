import {qs, $on, hideElement, toggleElement}
  from '/lib/util/view_helpers.js';
import {timeSince} from '/lib/util/date_format.js';

export const ViewTypes = {
  OLD: 'old',
  NEW: 'new',
  DIFF: 'diff',
};

/**
 * Initialise the main view.
 */
export function init() {
  initMenu();
}

/**
 * Initialise the dropdown menu.
 */
function initMenu() {
  const menu = qs('#menu');

  // Toggle the menu when its button is clicked
  $on(qs('#menuButton'), 'click', (event) => {
    toggleElement(menu);
    // Prevent the click from immediately closing the dropdown
    event.stopPropagation();
  });

  // Hide the menu when something else is clicked
  $on(window, 'click', ({target}) => {
    hideElement(menu);
  });
}

/**
 * @param {object} handlers - Object containing the following keys
 * settingsHandler - Called when the Page Settings menu item is clicked
 * debugHandler - Called when the Debug Info menu item is clicked.
 */
export function bindMenu({settingsHandler, debugHandler}) {
  $on(qs('#page-settings'), 'click', settingsHandler);
  $on(qs('#debug-info'), 'click', debugHandler);
}

/**
 * @param {Function} handler - Called when the View Dropdown choice changes.
 */
export function bindViewDropdownChange(handler) {
  $on(qs('#view-dropdown'), 'change', ({target}) => {
    if (target.value) {
      handler(target.value);
    }
  });
}

/**
 * Show the diff view of the specified page.
 *
 * @param {Page} page - Page object to view.
 * @param {string} html - HTML string with diff highlighting.
 */
export function viewDiff(page, html) {
  setTitle(page.title, page.url);
  if (page.isError()) {
    setSubtitle('This page returned an error when scanned. ' +
      'Click the title above to see what\'s wrong.');
  } else if (page.newScanTime == null) {
    setSubtitle('This page has not yet been scanned.');
  } else {
    const scanTime = timeSince(new Date(page.newScanTime));
    setSubtitle(`This page was last scanned ${scanTime}. ` +
      'The changes are highlighted.');
  }
  setViewDropdown(ViewTypes.DIFF);
  loadSandboxedIframe(html);
}

/**
 * Show the old view of the specified page.
 *
 * @param {Page} page - Page object to view.
 * @param {string} html - Old HTML string.
 */
export function viewOld(page, html) {
  setTitle(page.title, page.url);
  if (page.oldScanTime == null) {
    setSubtitle('There is no old version of this page available yet.');
  } else {
    const scanTime = timeSince(new Date(page.oldScanTime));
    setSubtitle(`This is the old version of the page, scanned ${scanTime}.`);
  }
  setViewDropdown(ViewTypes.OLD);
  loadSandboxedIframe(html);
}

/**
 * Show the new view of the specified page.
 *
 * @param {Page} page - Page object to view.
 * @param {string} html - New HTML string.
 */
export function viewNew(page, html) {
  setTitle(page.title, page.url);
  if (page.newScanTime == null) {
    setSubtitle('This page has not yet been scanned.');
  } else {
    const scanTime = timeSince(new Date(page.newScanTime));
    setSubtitle(`This is the new version of the page, scanned ${scanTime}.`);
  }
  setViewDropdown(ViewTypes.NEW);
  loadSandboxedIframe(html);
}

/**
 * @param {string} title - Title of the page.
 * @param {string} url - URL of the page.
 */
function setTitle(title, url) {
  document.title = `Update Scanner - ${title}`;

  const titleElement = qs('#title');
  titleElement.textContent = title;
  titleElement.href = url;
}

/**
 * @param {string} subtitle - Subtitle text to use below the main title (eg
 * describing when the page was last updated).
 */
function setSubtitle(subtitle) {
  const subtitleElement = qs('#subtitle');
  subtitleElement.textContent = subtitle;
}

/**
 * @param {ViewTypes} viewType - New value of the dropdown selection.
 */
function setViewDropdown(viewType) {
  const viewDropdown = qs('#view-dropdown');
  viewDropdown.value = viewType;
}

/**
 * Create a sandboxed iframe with the supplied unsafe HTML and insert it into
 * the main content area.
 *
 * @param {string} html - Unsafe HTML to load.
 */
function loadSandboxedIframe(html) {
  removeIframe();
  const iframe = document.createElement('iframe');
  iframe.id = 'frame';
  iframe.classList.add('frame');
  iframe.sandbox = 'allow-top-navigation allow-same-origin';
  iframe.addEventListener('load', () => {
    try {
      const doc = iframe.contentDocument;

      // Apply adaptive diff highlighting from the trusted extension context.
      // Scripts inside captured pages are intentionally blocked by the iframe
      // sandbox, but allow-same-origin lets the viewer safely style its DOM.
      const parseViewerColor = value => {
        if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return null;
        const m = value.match(/^rgba?\\(([^)]+)\\)$/i);
        if (!m) return null;
        const parts = m[1].split(',').map(x => x.trim());
        return {
          r: Number(parts[0]) || 0,
          g: Number(parts[1]) || 0,
          b: Number(parts[2]) || 0,
          a: parts.length > 3 ? Number(parts[3]) : 1,
        };
      };
      const viewerLum = c => {
        const f = v => { const x=v/255; return x<=0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055,2.4); };
        return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);
      };
      const viewerBackground = el => {
        let n = el;
        while (n && n.nodeType === 1) {
          const c = parseViewerColor(doc.defaultView.getComputedStyle(n).backgroundColor);
          if (c && c.a > 0.01) return c;
          n = n.parentElement;
        }
        return {r:255,g:255,b:255,a:1};
      };
      doc.querySelectorAll('[data-updatescan-diff-highlight="1"]').forEach(el => {
        const bg = viewerBackground(el.parentElement || el);
        const originalText = parseViewerColor(doc.defaultView.getComputedStyle(el).color);
        const darkByBackground = viewerLum(bg) < 0.48;
        const darkByText = originalText && viewerLum(originalText) > 0.62;
        const dark = darkByBackground || darkByText;
        el.style.setProperty('background-color', dark ? '#ffe36e' : 'rgba(214, 170, 0, 0.55)', 'important');
        el.style.setProperty('color', dark ? '#111111' : '#161000', 'important');
        el.style.setProperty('text-shadow', 'none', 'important');
        el.style.setProperty('border-radius', '2px', 'important');
        el.style.setProperty('box-shadow', dark ? '0 0 0 1px rgba(70,55,0,.8) inset,0 0 0 1px rgba(255,227,110,.75)' : '0 0 0 1px rgba(110,80,0,.45) inset', 'important');
      });
      const rows = [...doc.images].map((img, i) => {
        const cs = doc.defaultView.getComputedStyle(img);
        const r = img.getBoundingClientRect();
        const parent = img.parentElement;
        const pcs = parent ? doc.defaultView.getComputedStyle(parent) : null;
        return {
          i,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          rectWidth: Math.round(r.width),
          rectHeight: Math.round(r.height),
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
          position: cs.position,
          transform: cs.transform,
          parentDisplay: pcs ? pcs.display : '',
          parentVisibility: pcs ? pcs.visibility : '',
          parentOpacity: pcs ? pcs.opacity : '',
          className: img.className || '',
          original: img.getAttribute('data-updatescan-original-src') || '',
        };
      });
      console.table(rows);
      const imageAncestorDiagnostics = [...doc.images].map((img, i) => {
        const r = img.getBoundingClientRect();
        if (r.width < 120 || r.height < 70 || !img.naturalWidth) return null;
        const chain = [];
        let n = img;
        for (let depth = 0; n && depth < 7; depth++, n = n.parentElement) {
          const cs = doc.defaultView.getComputedStyle(n);
          const nr = n.getBoundingClientRect();
          chain.push({
            depth,
            tag: n.tagName,
            id: n.id || '',
            cls: typeof n.className === 'string' ? n.className : '',
            x: Math.round(nr.x), y: Math.round(nr.y),
            w: Math.round(nr.width), h: Math.round(nr.height),
            display: cs.display,
            position: cs.position,
            overflow: cs.overflow,
            flex: cs.flex,
            gridArea: cs.gridArea,
          });
        }
        return {i, original: img.getAttribute('data-updatescan-original-src') || '', chain};
      }).filter(Boolean).slice(0, 12);
      console.log('VIEWER IMAGE ANCESTORS JSON', JSON.stringify(imageAncestorDiagnostics));
        const imagePointStacks = [...doc.images].map((img, i) => {
          const r = img.getBoundingClientRect();
          if (r.width < 120 || r.height < 70 || !img.naturalWidth) return null;
          const x = Math.max(0, Math.min(doc.documentElement.clientWidth - 1, r.left + r.width / 2));
          const y = Math.max(0, Math.min(doc.documentElement.clientHeight - 1, r.top + r.height / 2));
          const stack = doc.elementsFromPoint(x, y).slice(0, 10).map((el, depth) => {
            const cs = doc.defaultView.getComputedStyle(el);
            const er = el.getBoundingClientRect();
            return {
              depth,
              tag: el.tagName,
              id: el.id || '',
              cls: typeof el.className === 'string' ? el.className : '',
              x: Math.round(er.x), y: Math.round(er.y),
              w: Math.round(er.width), h: Math.round(er.height),
              position: cs.position,
              zIndex: cs.zIndex,
              pointerEvents: cs.pointerEvents,
              opacity: cs.opacity,
              visibility: cs.visibility,
              background: cs.backgroundColor,
              href: el.getAttribute('href') || '',
              inlineStyle: el.getAttribute('style') || '',
              ariaHidden: el.getAttribute('aria-hidden') || '',
              hidden: !!el.hidden,
              text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
            };
          });
          return {
            i,
            src: img.currentSrc || img.src || '',
            centerX: Math.round(x),
            centerY: Math.round(y),
            imageIsTopmost: stack.length > 0 && stack[0].tag === 'IMG',
            stack,
          };
        }).filter(Boolean).slice(0, 12);
        console.log('VIEWER IMAGE POINT STACKS JSON', JSON.stringify(imagePointStacks));
        const absoluteElementDump = [...doc.querySelectorAll('*')].map((el, i) => {
          const cs = doc.defaultView.getComputedStyle(el);
          if (cs.position !== 'absolute') return null;
          const r = el.getBoundingClientRect();
          if (r.width < 120 || r.height < 70) return null;
          return {
            i,
            tag: el.tagName,
            cls: typeof el.className === 'string' ? el.className : '',
            href: el.getAttribute('href') || '',
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            computedLeft: cs.left,
            computedTop: cs.top,
            transform: cs.transform,
            inlineStyle: el.getAttribute('style') || '',
            hasImage: !!el.querySelector('img'),
            text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
          };
        }).filter(Boolean);
        console.log('VIEWER ABSOLUTE ELEMENTS JSON', JSON.stringify(absoluteElementDump));

      console.log('VIEWER IMAGE SUMMARY', {
        total: rows.length,
        invisible: rows.filter(x => x.rectWidth === 0 || x.rectHeight === 0 || x.display === 'none' || x.visibility === 'hidden' || x.opacity === '0' || x.parentDisplay === 'none' || x.parentVisibility === 'hidden' || x.parentOpacity === '0').length,
      });
    } catch (error) {
      console.error('VIEWER IMAGE DIAGNOSTIC FAILED', error);
    }
  });
  iframe.srcdoc = html;
  qs('#frameContainer').appendChild(iframe);
}

/**
 * Remove the iframe from the DOM, if it exists.
 */
function removeIframe() {
  const iframe = qs('#frame');
  if (iframe) {
    iframe.parentNode.removeChild(iframe);
  }
}
