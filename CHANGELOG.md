# Changelog

## 5.1.1 - 2026-10-13

### Fixed

- **Folder Settings now has the Autoscan interval**, like Global Settings. Links added to the folder start with that interval, and "Apply Autoscan interval to existing links" (together with "Apply to all existing links") pushes it to links already in the folder.

## 5.1.0 - 2026-10-13

Everything added since 5.0.0.

### New: backups that survive a reinstall

- Your pages are copied automatically into your bookmarks, in an
  **Update Scanner Reborn** folder under Other Bookmarks. Your folders and pages
  appear as ordinary bookmarks, and a "Backup data" folder holds a full backup
  (every page setting included) for each of the last 14 days. The browser's own
  daily bookmark backups protect that folder as well.
- A copy of your pages is saved before every restore, because restoring replaces
  all pages.
- If the extension's storage is ever empty (for example after the browser gives
  the add-on a new internal ID), it restores itself from the newest bookmark
  backup the next time it starts.
- The Restore page lists the automatic backups, so you can go back to an earlier
  day as well as restore from a file.
- If the page list suddenly shrinks to less than half, the earlier backup is kept
  untouched and the smaller one is saved next to it.

### New: only what you can see counts

- Rendered scans (Dynamic and Popup) mark the parts of a page that are not
  showing when it is captured: other carousel slides, closed menus and sections,
  off-screen text and screen-reader-only text. Those parts are ignored when
  comparing and in the Changes view. The page title, other head metadata,
  `<noscript>` and `<template>` content are ignored too. Rescan a page once so
  its snapshot carries the marks.
- Script and style code (analytics scripts, inlined CSS) is left out of the diff,
  so it never shows up as a change. The page still displays as captured.
- Rendered scans are taken at the same zoom every time, and each snapshot records
  the zoom and window width it was captured at. If the old and new pages were
  captured differently, the Changes view says so.

### New: change size and thresholds

- Finer change-threshold steps: every 10 characters up to 200, every 20 up to
  300, every 25 up to 500, then every 100 up to 1500 (the highest used to be 500).
  Existing page thresholds are unchanged.
- A change is measured in letters and digits of the visible text that changed.
  Spaces, punctuation and decoration such as `[ENG]` or `|` no longer count.
- With "ignore numbers" on, a highlight that is only a number, or a number with a
  `%` or `K`/`M`/`B` suffix (ratings and view counts such as `72%` or `8.1K`), is
  not counted as a change.
- A highlighted date or time ("October 12, 2026", "7 hours ago", "10:30 PM")
  counts as a single change however long it is written, instead of one change
  per character.
- Folder-wide change threshold and number handling, applied to every link in the
  folder (including subfolders) when you choose.
- Page settings show how big the changes on recent scans were, with a one-click
  suggested threshold that would have ignored them all.
- "View Changes" shows how much changed and how far that is over or under the
  threshold (for example "56 changed, 16 over the 40 threshold"). Hover it for
  how to read the numbers, what is normal for the page, and the text that was
  highlighted. Hover a link in the sidebar to see its last change and what is
  typical.

### Improved: the Changes view

- Unchanged words are no longer highlighted: random IDs that pages regenerate on
  every load are ignored, a highlight on text that appears equally often in the
  old and new page is dropped, and when no text changed the page is shown without
  highlights.
- Inlined page CSS is no longer counted as page text when comparing.

### Upgrade notes

- **New permission: `bookmarks`**, used only for the automatic backup above.
  Firefox asks you to approve it when you update.
- Install the new version over the existing one. Do not remove the add-on first:
  removing it deletes its stored pages.
- Rescan each page once so its snapshot carries the hidden-part marks.

## 5.0.0

Initial Update Scanner Reborn source release.
