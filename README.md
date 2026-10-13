# Update Scanner Reborn

<p>
  <a href="https://github.com/molitar/update-scanner-reborn/releases/latest"><img src="https://img.shields.io/github/v/release/molitar/update-scanner-reborn?label=release&color=blue" alt="Release"></a>
  <a href="https://github.com/molitar/update-scanner-reborn/releases"><img src="https://img.shields.io/github/v/release/molitar/update-scanner-reborn?include_prereleases&label=preview&color=orange" alt="Preview"></a>
  <a href="https://github.com/molitar/update-scanner-reborn/blob/main/LICENSE"><img src="https://img.shields.io/github/license/molitar/update-scanner-reborn?color=orange" alt="License"></a>
  <a href="https://github.com/molitar/update-scanner-reborn/releases"><img src="https://img.shields.io/github/downloads/molitar/update-scanner-reborn/total?color=green" alt="Downloads"></a>
</p>

Modern website change monitoring for Firefox 140 and newer.

Update Scanner Reborn is a modified continuation of the original
Update Scanner browser extension.

## Features

### Intelligent scanning

The extension automatically selects a suitable scanning mode:

- **Standard:** Fast HTML-based scanning.
- **Dynamic:** Background-tab rendering for JavaScript-heavy pages.
- **Popup:** Separate-window rendering when additional rendering is needed.

The first scan may take longer while the extension verifies the
appropriate scanning method. Verified settings are remembered
for subsequent scans. Users can also choose a mode manually.

### Global and folder-level controls

- Global change-detection controls.
- Folder-wide change threshold and number handling, applied to every link
  in the folder (including subfolders) when you choose.
- Fine change-threshold steps: every 10 characters up to 200, every 20 up to
  300, every 25 up to 500, then every 100 up to 1500, for pages with counters,
  rotating lists, or listing pages that add a batch of posts between scans. A
  change is measured in letters and digits of the visible text that changed;
  spaces, punctuation and decoration such as `[ENG]` or `|` do not count.
- Page settings show how big the changes seen on recent scans were, with a
  one-click suggested threshold that would have ignored them all.
- The "View Changes" option shows how much changed and how far that is over or
  under the threshold (for example "56 changed, 16 over the 40 threshold").
  Hover it for a plain explanation of how the numbers are read, what is normal
  for that page, and which threshold would ignore normal changes.
- Hover a link in the sidebar to see its last change and what is typical.
- Rendered scans are taken at the same zoom every time (whatever zoom you use
  for the site), and each snapshot records the zoom and window width it was
  captured at. If the old and new pages were captured differently, the Changes
  view says so, since pages can lay out and repeat content differently at
  different sizes.
- Inlined page CSS is no longer counted as page text when comparing.
- Script and style code (analytics scripts, inlined CSS) is left out of the
  diff, so it never shows up as a change; the page still displays as captured.
- Only what is showing counts. Rendered scans (Dynamic and Popup) mark the parts
  of the page that are not visible when captured (other carousel slides, closed
  menus and sections, off-screen and screen-reader-only text), and those parts
  are ignored when comparing and in the Changes view. The page title, other
  head metadata, `<noscript>` and `<template>` content are ignored too. Rescan a
  page once so its snapshot carries the marks.
- The "View Changes" hover lists the text that was highlighted (how many places,
  how many characters, and the biggest few), so you can see what a large change
  actually is.
- The Changes view no longer highlights unchanged words: random IDs that pages
  regenerate on every load (GitHub buttons, tooltips, menus) are ignored, a
  highlight on text that appears equally often in the old and new page is
  dropped, and when no text changed the page is shown without highlights.
- With "ignore numbers" on, a highlight that is only a number, or a number with a
  `%` or `K`/`M`/`B` suffix (ratings and view counts such as `72%` or `8.1K`),
  is not counted as a change.
- A highlighted date or time ("October 12, 2026", "7 hours ago", "10:30 PM")
  counts as a single change however long it is written, rather than one change
  per character.
- Folder-wide notification settings.
- Folder-wide scanning-mode configuration.
- Individual website settings.

### Improved page monitoring

- Enhanced JavaScript-rendered page snapshots.
- Image readiness checks and lazy-loading support.
- Image embedding and improved layout preservation.
- Orange-brown change highlighting for light and dark pages.
- Manual scan priority with automatic queue continuation.
- Background-tab scanning without stealing focus.
- Live sidebar scanning indicators.

### Notifications

- Configurable desktop notification duration.
- Optional persistent notifications.
- Default and custom audio alerts.

### Backups that survive a reinstall

- Your pages are copied automatically into your bookmarks, in an
  **Update Scanner Reborn** folder under Other Bookmarks: your folders and pages
  as ordinary bookmarks, plus a "Backup data" folder with a full backup (all
  page settings included) for each of the last 14 days. The browser's own
  daily bookmark backups then protect it as well.
- A copy of your pages is saved before every restore, because restoring
  replaces all pages.
- If the extension's storage is ever empty (for example after the browser gives
  it a new internal ID), it restores itself from the newest bookmark backup the
  next time it starts.
- The Restore page lists the automatic backups, so you can go back to an
  earlier day as well as restore from a file.
- If the page list suddenly shrinks to less than half, the earlier backup is
  kept untouched and the smaller one is saved next to it.

## Installation


Firefox Add-ons:

https://addons.mozilla.org/en-US/firefox/addon/update-scanner-reborn-v5-0-0/

Availability depends on Mozilla approval.

## Compatibility

- Firefox desktop 140 or newer.
- Manifest V2.
- Uses the `bookmarks` permission, only to keep the automatic backup described above.

## Source code

The repository contains the extension source and bundled
runtime dependencies used to create the release package.

## Original project

Based on Update Scanner by sneakypete81 and contributors:

https://github.com/sneakypete81/updatescanner

See [NOTICE.md](NOTICE.md) for attribution and modifications.

## License

GNU General Public License version 3.

See [LICENSE](LICENSE) and
[THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).

## Community & Support

We welcome bug reports, feature suggestions, questions, and feedback.

- **Report a bug:** [GitHub Issues](https://github.com/molitar/update-scanner-reborn/issues/new/choose)
- **Request a feature:** [Feature Requests](https://github.com/molitar/update-scanner-reborn/issues/new/choose)
- **Discuss ideas and ask questions:** [GitHub Discussions](https://github.com/molitar/update-scanner-reborn/discussions)
- **Download releases:** [GitHub Releases](https://github.com/molitar/update-scanner-reborn/releases)
- **Latest release:** [Update Scanner Reborn v5.1.1](https://github.com/molitar/update-scanner-reborn/releases/tag/v5.1.1)

When reporting a bug, please include your Firefox version, the
website being scanned (if appropriate), the selected scanning mode,
steps to reproduce the issue, and screenshots where useful.
