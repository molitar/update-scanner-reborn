# Update Scanner Reborn

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

## Installation

Firefox Add-ons:

https://addons.mozilla.org/en-US/firefox/addon/update-scanner-reborn-v5-0-0/

Availability depends on Mozilla approval.

## Compatibility

- Firefox desktop 140 or newer.
- Manifest V2.

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
- **Latest release:** [Update Scanner Reborn v5.0.0](https://github.com/molitar/update-scanner-reborn/releases/tag/v5.0.0)

When reporting a bug, please include your Firefox version, the
website being scanned (if appropriate), the selected scanning mode,
steps to reproduce the issue, and screenshots where useful.
