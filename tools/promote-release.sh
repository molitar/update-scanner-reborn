#!/usr/bin/env bash
# Turn a pre-release into the normal "latest" release once Mozilla has signed it.
#
# Usage:
#   tools/promote-release.sh VERSION SIGNED.xpi [--yes]
#
#   tools/promote-release.sh 5.1.0 ~/Downloads/update_scanner_reborn-5.1.0.xpi
#
# It replaces the unsigned xpi on the release with the signed one (same file name,
# update_scanner_reborn-<version>.xpi), removes the pre-release mark and makes the
# release the latest one. Run it from anywhere; it only needs the GitHub CLI.

set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }

ASSUME_YES=0
VERSION=""
SIGNED=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) if [ -z "$VERSION" ]; then VERSION="${arg#v}"; elif [ -z "$SIGNED" ]; then SIGNED="$arg"; else die "too many arguments"; fi ;;
  esac
done
[ -n "$VERSION" ] && [ -n "$SIGNED" ] || die "usage: tools/promote-release.sh VERSION SIGNED.xpi"
TAG="v$VERSION"
REPO_SLUG="${REPO_SLUG:-molitar/update-scanner-reborn}"
ASSET="update_scanner_reborn-$VERSION.xpi"

GH=gh
if ! command -v gh >/dev/null && command -v gh.exe >/dev/null; then GH=gh.exe; fi
command -v "$GH" >/dev/null || die "the GitHub CLI (gh) is not installed"
native_path() {
  if [ "$GH" = "gh.exe" ] && command -v wslpath >/dev/null; then wslpath -w "$1"; else printf '%s' "$1"; fi
}

[ -f "$SIGNED" ] || die "signed xpi not found: $SIGNED"
python3 - "$SIGNED" "$VERSION" <<'PY' || exit 1
import json
import sys
import zipfile

path, version = sys.argv[1:3]
try:
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
except Exception as exc:
    sys.exit("ERROR: not a valid xpi: %s" % exc)
if manifest.get("version") != version:
    sys.exit("ERROR: the xpi is version %s, not %s" % (manifest.get("version"), version))
signed = any(n.startswith("META-INF/") for n in names)
print("    xpi version %s, %d files, Mozilla signature present: %s" % (version, len(names), "yes" if signed else "NO"))
if not signed:
    sys.exit("ERROR: this xpi is not signed (no META-INF/). Download the signed file from addons.mozilla.org.")
PY

"$GH" auth status >/dev/null 2>&1 || die "not logged in to GitHub. Run:  $GH auth login"
"$GH" release view "$TAG" --repo "$REPO_SLUG" >/dev/null 2>&1 || die "release $TAG does not exist on $REPO_SLUG"

say "Release $TAG on $REPO_SLUG"
"$GH" release view "$TAG" --repo "$REPO_SLUG" --json isPrerelease,assets --jq '"    pre-release now: \(.isPrerelease)   assets: \([.assets[].name] | join(", "))"'

if [ "$ASSUME_YES" = "0" ]; then
  printf '\nReplace the xpi with the signed one and make %s the latest release? [y/N] ' "$TAG"
  read -r answer < /dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) ;; *) say "Cancelled. Nothing was changed."; exit 1 ;; esac
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp "$SIGNED" "$TMP/$ASSET"
say "Uploading the signed xpi as $ASSET"
"$GH" release upload "$TAG" "$(native_path "$TMP/$ASSET")" --repo "$REPO_SLUG" --clobber
say "Making it the latest release"
"$GH" release edit "$TAG" --repo "$REPO_SLUG" --prerelease=false --latest
say "Done."
"$GH" release view "$TAG" --repo "$REPO_SLUG" --json url --jq .url
