import {highlightDiffs} from './diff_engine.js';

/**
 * Compare the two already-captured HTML snapshots.
 *
 * Rendering, scrolling, CSS collection, and lazy-content loading happen
 * during scan time. Viewing a stored page must never reopen the live site.
 *
 * @param {Page} page - Page object to diff.
 * @param {string} oldHtml - Previously stored rendered snapshot.
 * @param {string} newHtml - Most recently stored rendered snapshot.
 *
 * @returns {string} Highlighted stored HTML.
 */
function seedIsHighlight(el) {
  const style = (el.getAttribute("style") || "")
    .toLowerCase()
    .replace(/\s+/g, "");

  return (
    style.includes("background:#fff58a") ||
    style.includes("background-color:#fff58a") ||
    style.includes("background:rgb(255,245,138)") ||
    style.includes("background-color:rgb(255,245,138)") ||
    style.includes("background:rgba(255,245,138,1)") ||
    style.includes("background-color:rgba(255,245,138,1)")
  );
}

function injectAdaptiveHighlighting(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const highlighted = [...doc.querySelectorAll("[style]")].filter(seedIsHighlight);

  if (!highlighted.length) {
    return html || "";
  }

  highlighted.forEach(el => {
    el.setAttribute("data-updatescan-diff-highlight", "1");
    // Softer default for dark pages even if script execution is delayed/blocked.
    el.style.setProperty(
      "background-color",
      "rgba(255, 245, 120, 0.22)",
      "important",
    );
  });

  const style = doc.createElement("style");
  style.setAttribute("data-updatescan-adaptive-highlight-style", "1");
  style.textContent = `
    [data-updatescan-diff-highlight="1"] {
      transition: background-color 120ms linear, box-shadow 120ms linear;
    }
  `;
  doc.head.appendChild(style);

  const script = doc.createElement("script");
  script.setAttribute("data-updatescan-adaptive-highlight-script", "1");
  script.textContent = `(function () {
    function parseColor(input) {
      if (!input) return null;
      const value = input.trim().toLowerCase();

      if (
        !value ||
        value === "transparent" ||
        value === "rgba(0, 0, 0, 0)" ||
        value === "rgba(0,0,0,0)"
      ) {
        return null;
      }

      const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (hex) {
        let h = hex[1];
        if (h.length === 3) {
          h = h.split("").map(ch => ch + ch).join("");
        }
        return {
          r: parseInt(h.slice(0, 2), 16),
          g: parseInt(h.slice(2, 4), 16),
          b: parseInt(h.slice(4, 6), 16),
          a: 1,
        };
      }

      const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
      if (rgb) {
        const parts = rgb[1].split(",").map(x => x.trim());
        return {
          r: Math.max(0, Math.min(255, parseFloat(parts[0]) || 0)),
          g: Math.max(0, Math.min(255, parseFloat(parts[1]) || 0)),
          b: Math.max(0, Math.min(255, parseFloat(parts[2]) || 0)),
          a: parts.length > 3 ? Math.max(0, Math.min(1, parseFloat(parts[3]) || 0)) : 1,
        };
      }

      return null;
    }

    function effectiveBackground(el) {
      let node = el;
      while (node && node.nodeType === 1) {
        const color = parseColor(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0.01) {
          return color;
        }
        node = node.parentElement;
      }
      return {r: 255, g: 255, b: 255, a: 1};
    }

    function channelLuminance(value) {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }

    function luminance(color) {
      return (
        0.2126 * channelLuminance(color.r) +
        0.7152 * channelLuminance(color.g) +
        0.0722 * channelLuminance(color.b)
      );
    }

    function applyAdaptiveHighlights() {
      document.querySelectorAll('[data-updatescan-diff-highlight="1"]').forEach(el => {
        const bg = effectiveBackground(el.parentElement || el);
        const isDarkBackground = luminance(bg) < 0.48;

        el.style.setProperty(
          "background-color",
          isDarkBackground
            ? "#ffe36e"                     // clearly visible warm yellow on dark UI
            : "rgba(214, 170, 0, 0.45)",    // darker yellow on light UI
          "important",
        );

        if (isDarkBackground) {
          el.style.setProperty("color", "#111111", "important");
          el.style.setProperty("text-shadow", "none", "important");
          el.style.setProperty("border-radius", "2px", "important");
        }

        el.style.setProperty(
          "box-shadow",
          isDarkBackground
            ? "0 0 0 1px rgba(70, 55, 0, 0.65) inset, 0 0 0 1px rgba(255, 227, 110, 0.45)"
            : "0 0 0 1px rgba(133, 102, 0, 0.18) inset",
          "important",
        );
      });
    }

    const run = () => requestAnimationFrame(() => requestAnimationFrame(applyAdaptiveHighlights));

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", run, {once: true});
    } else {
      run();
    }
  })();`;

  (doc.body || doc.documentElement).appendChild(script);
  return doc.documentElement.outerHTML;
}

export function diff(page, oldHtml, newHtml) {
  const diffHtml = highlightDiffs(oldHtml || '', newHtml || '', '#fff58a', '', '');
  return injectAdaptiveHighlighting(diffHtml);
}
