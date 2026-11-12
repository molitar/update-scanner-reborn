# Update Scanner Reborn

| Preview Builds | Release Builds | License | Downloads |
|:---:|:---:|:---:|:---:|
| [![Preview](https://img.shields.io/github/v/release/molitar/update-scanner-reborn?include_prereleases&label=preview&color=orange&cacheSeconds=300)](https://github.com/molitar/update-scanner-reborn/releases) | [![Download](https://img.shields.io/github/v/release/molitar/update-scanner-reborn?label=download&color=blue&cacheSeconds=300)](https://github.com/molitar/update-scanner-reborn/releases/latest) | [![License](https://img.shields.io/github/license/molitar/update-scanner-reborn?color=orange)](https://github.com/molitar/update-scanner-reborn/blob/main/LICENSE) | [![Downloads](https://img.shields.io/github/downloads/molitar/update-scanner-reborn/total?color=green)](https://github.com/molitar/update-scanner-reborn/releases) |

Modern website change monitoring for Firefox 140 and newer.

Update Scanner Reborn is a modified continuation of the original
Update Scanner browser extension.

**Documentation:** the [User Guide](https://github.com/molitar/update-scanner-reborn/wiki/User-Guide)
explains everything step by step, and
[Installing a Preview Build](https://github.com/molitar/update-scanner-reborn/wiki/Installing-a-Preview-Build)
shows how to try a version before Mozilla has signed it.

## Features

### Intelligent scanning

Choose **Automatic (recommended)** and the extension picks the lightest scan
mode that captures the page completely:

- **Standard:** Fast HTML-based scanning. About 10 seconds the first time
  (while it checks that the page is complete), about 2 seconds after that.
- **Dynamic:** Background-tab rendering for JavaScript-heavy pages. Typically
  about 15 seconds (two passes); a few sites that need a third or fourth pass
  take longer.
- **Popup:** Separate-window rendering when a page needs it, for example sites
  that only paint their pictures in a visible window or show a "verify you are
  human" check. About 30 seconds.

Automatic steps up and **stops as soon as one stage captures the page
completely**: Standard first (up to 10 seconds, retried while the page loads),
then Dynamic (up to the **Maximum Dynamic Scan Time**, 20 to 45 seconds, 25 by
default, set in Global Settings), then Popup as the last fallback. It
remembers what each page needed, so a link that needed Popup goes straight to
Popup next time, and a site that is briefly down can never push a page up to a
slower mode. The page header shows how a page was scanned ("last scanned today
using dynamic at 21:36").

You can also choose a mode by hand. A hand-picked mode is the mode that is
used. The **Lock** switch means the mode never changes for any reason and no
other kind of scan is tried, even when scans fail. Choose Automatic again (or
turn the lock off) to have the page checked again.

Scans are quick but thorough: Dynamic and Popup sweep the page up to three
times, a little slower each time, skip the third sweep when every image has
already loaded, and only add a slower fourth sweep when pictures are still
missing.

### Global and folder-level controls

- Global change-detection controls.
- Folder-wide change threshold and number handling, applied to every link
  in the folder (including subfolders) when you choose.
- Fine change-threshold steps: 0 (all changes), then every 5 characters up to
  50, every 10 up to 200, every 20 up to 300, every 25 up to 500, then every 100 up to 1500, for pages with counters,
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
- Folder-wide scanning-mode configuration, with an optional lock.
- Each "Apply to existing links" box sits right under the setting it covers, and
  starts unticked.
- Sort a folder, or everything, alphabetically in one go.
- Settings open in their own tab beside the one you are on, and pages you click
  open in the same tab inside Update Scanner or in a new tab next to a site you
  are reading.
- Individual website settings.

### Select parts of a page: Include, Ignore, Exclude

Press **Select parts...** in the page view and a small floating window opens.
Click the part, use **Up / Down** (or the arrow keys) until the cyan dashed
outline covers exactly that part, choose what **Add & Next** does, and press
**Add & Next**; pick more parts, then **Finish**.

- **Include:** only the selected regions count as changes; the rest of the page stays visible.
- **Ignore:** a rotating ticker, a visitors-online box or an advert slot is left out of the comparison but stays visible.
- **Exclude:** like Ignore, and the part is removed from the saved view and can be copied as a uBlock Origin filter.

Nothing inside an ignored or excluded part is ever compared, counted or
highlighted. The list is per link and is shown in Page Settings under
**Selected parts**, where each part can be removed. On ad-heavy sites the live
picker can also look through invisible click layers, block an exact third-party
script host and (optionally) third-party frames.

### Ignoring numbers, dates and times

- **Ignore changes to numbers** works in the comparison itself, so a changed counter
  ("24 Guests" to "21 Guests") or a running clock never creates a highlight.
- **Ignore changes to dates and times** treats a clock, `Today at 7:46 PM`,
  `October 29, 2026`, `2026-10-29` or `7 hours ago` as no change.

### Listing pages: count changed blocks

On a forum, blog or shop page each post is a block (title, date, picture, text).
Counted by characters one new post can look like hundreds of changes. Tick
**Count each changed block (post, item) as one change** (link, folder or global
settings) and a post with anything changed in it counts as **one** change:

- The Change Threshold becomes a number of blocks, with fine steps: 1 to 25, then
  30, 35, 40, 45, 50, 60, 70.
- A post that only moved down the page because a new one was added is not a
  change. **Blocks this alike count as the same** (a slider from 1% to 100%, 60% by default; a tuning bar in the Changes view, switched on in Page Settings, shows the counts following it live) also
  ignores a new comment count or one edited word.
- The highlight goes on the text that really changed, or on the title of a new
  post, and the picture stays clearly visible. Next / Previous makes one stop per
  block.

### Pages translated by the browser

Firefox's built-in page translation rewrites text only as it scrolls into view,
so a quick scan can capture half-translated text. Turn on **Page is translated
by the browser** for such a link and its Popup scan pauses a little longer on the
first sweep. Off (the default) keeps the fastest scan.

### Improved page monitoring

- Enhanced JavaScript-rendered page snapshots.
- Image readiness checks and lazy-loading support.
- Image embedding and improved layout preservation.
- Orange-brown change highlighting for light and dark pages.
- Manual scan priority with automatic queue continuation.
- Background-tab scanning without stealing focus.
- Live sidebar scanning indicators.
- Websites that are down: your last good copy is kept, a grey first failure, one
  recheck three hours later, then a red status, a notification and a badge count.
- Cloudflare error pages (such as error 521) are recognised.
- **Delete all pages** (Folder and Global Settings) behind two confirmations.

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

https://addons.mozilla.org/en-US/firefox/addon/update-scanner-reborn/

Availability depends on Mozilla approval.

### Trying a preview build

Preview builds (marked **Pre-release** on the
[Releases](https://github.com/molitar/update-scanner-reborn/releases) page) are
not signed by Mozilla yet, so regular Firefox will not install them the normal
way. To try one:

1. Download the `.xpi` file from the release.
2. In Firefox, open `about:debugging` and click **This Firefox**.
3. Click **Load Temporary Add-on...** and choose the downloaded `.xpi`.
4. The add-on stays loaded until Firefox is restarted, then it has to be loaded
   again.

Use **Backup** from the toolbar menu first, as with any new version. On Firefox
Developer Edition or Nightly you can instead set `xpinstall.signatures.required`
to `false` in `about:config` and install the file permanently. More detail is on
the wiki page
[Installing a Preview Build](https://github.com/molitar/update-scanner-reborn/wiki/Installing-a-Preview-Build).

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
- **Ask a question:** [Discussions, Q&A](https://github.com/molitar/update-scanner-reborn/discussions/categories/q-a)
- **Request a feature or share an idea:** [Discussions, Ideas](https://github.com/molitar/update-scanner-reborn/discussions/categories/ideas)
- **Download releases:** [GitHub Releases](https://github.com/molitar/update-scanner-reborn/releases)
- **Latest release:** [Update Scanner Reborn, latest version](https://github.com/molitar/update-scanner-reborn/releases/latest)

When reporting a bug, please include your Firefox version, the
website being scanned (if appropriate), the selected scanning mode,
steps to reproduce the issue, and screenshots where useful.
