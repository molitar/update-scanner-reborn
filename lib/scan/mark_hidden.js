// Script run inside the live scan tab just before the page is saved. It marks
// every part of the page that is not showing with data-updatescan-hidden="1".
// Comparisons and the Changes view then ignore marked parts, so only what is
// actually on the page counts. Parts that are not showing include:
//   - display:none, visibility:hidden and opacity:0 (and everything inside)
//   - parts that have no box at all: closed <details>, the options of a closed
//     dropdown, collapsed sections
//   - parts pushed completely outside an overflow:hidden/clip box, such as the
//     other slides of a carousel track
//   - parts placed off the top or left edge of the page (off-screen text)
//   - "screen reader only" text that is clipped to a pixel
//
// Deliberately cautious: it only marks what is clearly not showing. Anything it
// is unsure about stays counted, so a real change is never ignored by mistake.
//   - NOT scrollable boxes (overflow:auto/scroll): their content can be reached
//   - NOT absolutely or fixed positioned parts (they can escape a clipping box)
export const MARK_HIDDEN_PARTS_JS = `
  (function () {
    var SKIP = {HEAD: 1, SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, TITLE: 1,
      TEMPLATE: 1, NOSCRIPT: 1, BASE: 1};
    var MARK = 'data-updatescan-hidden';
    var scrollX = window.scrollX || 0;
    var scrollY = window.scrollY || 0;

    function outside(rect, clip) {
      return rect.right <= clip.left || rect.left >= clip.right ||
        rect.bottom <= clip.top || rect.top >= clip.bottom;
    }

    function shrink(clip, rect) {
      if (!clip) {
        return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
      }
      return {
        left: Math.max(clip.left, rect.left), top: Math.max(clip.top, rect.top),
        right: Math.min(clip.right, rect.right), bottom: Math.min(clip.bottom, rect.bottom)
      };
    }

    function hide(node) {
      node.setAttribute(MARK, '1');
    }

    function walk(parent, clip) {
      var children = parent.children;
      for (var i = 0; i < children.length; i++) {
        var node = children[i];
        if (SKIP[node.tagName]) continue;
        var style = getComputedStyle(node);

        // display:contents has no box of its own; look at what is inside.
        if (style.display === 'contents') { walk(node, clip); continue; }

        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.opacity === '0') {
          hide(node);
          continue;
        }

        // No box at all: closed <details>, options of a closed dropdown, etc.
        if (typeof node.getClientRects === 'function' &&
            node.getClientRects().length === 0) {
          hide(node);
          continue;
        }

        var positioned = style.position === 'absolute' || style.position === 'fixed';
        var rect = node.getBoundingClientRect();
        var clips = style.overflowX === 'hidden' || style.overflowX === 'clip' ||
          style.overflowY === 'hidden' || style.overflowY === 'clip';

        // Text parked off the top or left edge of the page cannot be scrolled to.
        if ((rect.width > 0 || rect.height > 0) &&
            (rect.right + scrollX <= 0 || rect.bottom + scrollY <= 0)) {
          hide(node);
          continue;
        }

        // "Screen reader only" text: clipped down to a pixel or less.
        var cut = style.clip || '';
        var path = style.clipPath || '';
        if ((clips && rect.width <= 2 && rect.height <= 2) ||
            (positioned && (cut.indexOf('rect(0') === 0 || cut.indexOf('rect(1px') === 0)) ||
            path.indexOf('inset(50%') === 0 || path.indexOf('inset(100%') === 0) {
          hide(node);
          continue;
        }

        if (!positioned && clip && outside(rect, clip)) {
          hide(node);
          continue;
        }

        var next = positioned ? null : clip;
        if (clips) next = shrink(next, rect);
        walk(node, next);
      }
    }

    try {
      if (document.body) {
        walk(document.body, null);
        // Shows the page was checked, even if nothing in it was hidden.
        document.body.setAttribute('data-updatescan-marked', '1');
      }
    } catch (e) {
      // Marking is best effort: if anything goes wrong the page is saved
      // unmarked and everything counts, as before.
    }
  })();
`;
