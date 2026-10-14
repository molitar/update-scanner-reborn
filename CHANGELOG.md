# Changelog

## 5.1.4 - 2026-10-14

### Faster scans

Scans are quicker without capturing less. Typical times:

| Scan mode | Typical time |
|---|---|
| **Standard** (first check) | about **10 seconds**, then a plain fetch of about 2 seconds on every later scan |
| **Dynamic** | about **15 seconds** when two sweeps are enough, longer (up to about 25 to 30) when a third and fourth sweep are needed |
| **Popup** | about **30 seconds** |

- **Dynamic now typically finishes in about 15 seconds, after two passes,** and only takes longer when a site needs a third or fourth pass. Overall scan times are noticeably shorter. Dynamic and Popup scan in up to four passes: The page is swept from top to bottom a little slower each time (about 4, 5 and 6 seconds). After the second sweep the scanner checks whether every image has loaded; if so, the third sweep is skipped. If images are still missing after the third sweep, one slower fourth sweep (8 seconds) follows, and only then is the page judged to need a deeper mode.
- **Short waits.** The page starts to be scrolled 1 second after it is ready, so lazy-loaded images start loading sooner. The check that every image has loaded no longer waits on timers that a background tab slows down. When everything is loaded the scan goes back to the top, settles for 2 seconds and closes, without a long final wait.
- **A slow ad can no longer hold a scan back** for 20 or more seconds.
- **The Standard check is a quick look, never more than 10 seconds.** The check that decides whether the fast Standard scan is enough opens the page, makes one quick pass over it and reads it, without building a saved copy.

### New: Automatic scan mode and a Lock switch

- **Scan mode** now starts with **Automatic (recommended)**, followed by Standard, Dynamic and Popup, in **Page Settings**, **Folder Settings** and **Global Settings**.
- **Automatic works out the best scan mode once.** On the first scan it starts with Standard, and if the page is not fully captured it moves to Dynamic, then Popup. After that it **keeps that mode**, and the dropdown shows what it found, so a site that is down for maintenance can never push a page up to a deeper mode later.
- **Automatic settles on sites that block a plain fetch.** A site that answers the Standard scan with "Forbidden" or a Cloudflare check goes to Dynamic straight away and is checked against Popup.
- **A mode you pick by hand is the mode that is used.** Dynamic and Popup are never checked or changed. A hand-picked Standard gets the same 10-second quick look once and only writes what it finds in the log; it never changes the mode.
- **Lock scan mode** is your own choice, picking a mode does not turn it on. A locked mode never changes for any reason, is never checked, and no other kind of scan is tried even when scans keep failing (you get a normal error instead).
- **Reset to Automatic.** For one link, choose Automatic or turn the lock off; it starts over and is checked once, on its next scan. For a folder or Global Settings, choose Automatic and tick the box under Scan mode to reset all existing links.
- In a folder or in Global Settings, the scan mode is also the default for new links.

### Better settings

- **Simpler Folder Settings and Global Settings.** Each "Apply to existing links" box sits directly under the setting it covers (Autoscan, Change Threshold and numbers, Scan mode and lock, Notifications) with a label that says exactly what it changes. They all start unchecked, so nothing on your existing links is changed unless you tick it. The separate block of boxes at the bottom is gone.
- **Sort your folders and links.** Global Settings and Folder Settings can sort everything alphabetically (A to Z, numbers in order). **List folders before links** is no longer ticked by default, and becomes selectable once you tick the sort option.
- **Settings open in their own tab,** to the right of the tab you are on. They no longer replace the page you were looking at, the tab closes when you are done, and you land back on the tab you came from instead of one that is busy scanning.
- **Pages open where you expect.** From the sidebar or the toolbar popup, a page you click opens in the same tab when you are already looking at an Update Scanner page, and in a new tab right next to the current one when you are on any other site, so the site you were reading is never replaced.

### More accurate captures

- **The page header says how it was scanned**, for example "This page was last scanned today using dynamic at 21:36." It shows the mode that really did the scan.
- **Standard must show a whole page.** The Standard check looks at the saved HTML the way the viewer shows it (without scripts). If most of its text stays invisible until the site's scripts reveal it, if it shows less than one page, or if far fewer words show than on the live page, Automatic moves the link to a deeper mode.
- **Pictures in saved pages keep their original size and detail.** When a site refuses direct downloads, the scanner fetches the picture's own file the way the page does, instead of redrawing it, so covers are saved whole.
- **A "verify you are human" check no longer gets the Popup scan window closed on you.** If a site (for example one behind Cloudflare) shows its checkbox in the Popup scan, the window is brought to the front, a notification tells you, and the scan waits up to 90 seconds for you to tick it.
- **Dynamic and Popup scans no longer jump to a deeper mode because slow ads did not load.**
- **Loading placeholders alone no longer force Dynamic.** Grey shimmering bars (like the commit details on a GitHub page) are only noted in the log; the page's real text decides.

## 5.1.2 - 2026-10-13

### New: sort your folders and links

- **Global Settings** has a new **Sorting** section: tick *Sort all folders and links alphabetically (A to Z)* and press OK to sort the whole list in one go.
- **Folder Settings** has the same option for a single folder: *Sort this folder and the folders inside it alphabetically (A to Z)*.
- Sorting ignores upper/lower case and puts numbers in order (Video 2 comes before Video 10). *List folders before links* is on by default; untick it to mix folders and links together.
- It only reorders; nothing is renamed or removed, and folders that are already in order are left untouched.

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
