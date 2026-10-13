#!/usr/bin/env bash
# Publish a release of Update Scanner Reborn to GitHub in one step.
#
# Usage:
#   tools/publish-release.sh NOTES.md [--prerelease] [--yes] [--dry-run]
#
# NOTES.md is the release notes file you wrote (a path, or just a name inside
# release-notes/). The version comes from manifest.json, so bump that first.
#
# What it does, in order:
#   1. Checks everything is in order (branch, GitHub login, version not released yet,
#      notes mention the version, nothing newer on GitHub).
#   2. Builds update_scanner_reborn-<version>.xpi from the extension files.
#   3. Adds the notes to release-notes/ and CHANGELOG.md.
#   4. Shows a summary and asks you to confirm (skip with --yes).
#   5. Commits everything, tags v<version>, pushes, and creates the GitHub release
#      with the xpi attached and the notes as its description.
#
# If a previous run pushed the code and the tag but could not create the release,
# running the same command again only creates the release (nothing is pushed twice).
#
# --prerelease  marks the GitHub release as a pre-release (for example while the
#               xpi is unsigned and waiting for Mozilla). tools/promote-release.sh
#               turns it into the normal release once the signed xpi is attached.
# --replace     redo a version that is already released (for example a fix made before
#               Mozilla signed it): commits the changes, moves the tag, deletes the
#               GitHub release and creates it again with the new xpi.
# --dry-run     does steps 1, 2 and the summary only: nothing is committed or pushed.
#
# Set XPI_OUT_DIR to change where the xpi is written (default ~/update-scanner-builds).
#
# Works with the GitHub CLI installed in Linux (gh) or, from WSL, the Windows one
# (gh.exe), so GitHub credentials can stay on the Windows PC.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BRANCH="main"
REMOTE="origin"
OUT_DIR="${XPI_OUT_DIR:-$HOME/update-scanner-builds}"
NOTES_ARG=""
ASSUME_YES=0
DRY_RUN=0
PRERELEASE=0
REPLACE=0
REPLACING=0

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --prerelease|-p) PRERELEASE=1 ;;
    --replace) REPLACE=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $arg" ;;
    *) [ -z "$NOTES_ARG" ] || die "only one notes file, got a second: $arg"; NOTES_ARG="$arg" ;;
  esac
done
[ -n "$NOTES_ARG" ] || die "give the release notes file, e.g.  tools/publish-release.sh release-notes/5.1.0.md"

# ---------------------------------------------------------------- 1. checks
for tool in git python3; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done

# GitHub CLI: the Linux one, or from WSL the Windows one (then file paths must be
# given to it in Windows form, and git asks it for the GitHub login).
GH=gh
if ! command -v gh >/dev/null && command -v gh.exe >/dev/null; then GH=gh.exe; fi
command -v "$GH" >/dev/null || die "the GitHub CLI (gh) is not installed"
GIT_AUTH=()
if [ "$GH" = "gh.exe" ]; then
  GIT_AUTH=(-c "credential.helper=" -c "credential.helper=!gh.exe auth git-credential")
fi
native_path() {
  if [ "$GH" = "gh.exe" ] && command -v wslpath >/dev/null; then wslpath -w "$1"; else printf '%s' "$1"; fi
}
git_remote() { git ${GIT_AUTH[@]+"${GIT_AUTH[@]}"} "$@"; }

# Name the GitHub repository explicitly (owner/name), so the GitHub CLI never has to
# inspect this folder itself (the Windows CLI cannot safely do that from WSL).
repo_slug() {
  local url
  url="$(git config --get "remote.$REMOTE.url" 2>/dev/null || true)"
  case "$url" in
    https://github.com/*|git@github.com:*)
      url="${url#https://github.com/}"; url="${url#git@github.com:}"; printf '%s' "${url%.git}" ;;
  esac
}
REPO_SLUG="${REPO_SLUG:-$(repo_slug)}"
GH_REPO=()
[ -z "$REPO_SLUG" ] || GH_REPO=(--repo "$REPO_SLUG")
gh_cmd() { "$GH" "$@" ${GH_REPO[@]+"${GH_REPO[@]}"}; }

NOTES=""
for candidate in "$NOTES_ARG" "release-notes/$NOTES_ARG" "$REPO/$NOTES_ARG"; do
  if [ -f "$candidate" ]; then NOTES="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"; break; fi
done
[ -n "$NOTES" ] || die "notes file not found: $NOTES_ARG"
[ -s "$NOTES" ] || die "notes file is empty: $NOTES"

VERSION="$(python3 -c 'import json,sys; print(json.load(open("manifest.json", encoding="utf-8"))["version"])')"
[ -n "$VERSION" ] || die "could not read the version from manifest.json"
TAG="v$VERSION"
XPI="$OUT_DIR/update_scanner_reborn-$VERSION.xpi"

grep -qF "$VERSION" "$NOTES" || die "the notes never mention $VERSION. Add a heading such as '## $VERSION' (this guards against publishing with a stale version in manifest.json)."

[ "$(git branch --show-current)" = "$BRANCH" ] || die "switch to the $BRANCH branch first (on $(git branch --show-current))"

say "Checking GitHub"
git_remote fetch --quiet "$REMOTE" "$BRANCH" --tags || die "could not reach $REMOTE"
BEHIND="$(git rev-list --count "HEAD..$REMOTE/$BRANCH")"
[ "$BEHIND" = "0" ] || die "GitHub has $BEHIND newer commit(s) than this copy. Pull them first (git pull --rebase)."

RESUME=0
TAG_EXISTS=0
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && TAG_EXISTS=1
[ "$TAG_EXISTS" = "1" ] || [ -z "$(git_remote ls-remote --tags "$REMOTE" "refs/tags/$TAG")" ] || TAG_EXISTS=1
if [ "$DRY_RUN" = "0" ] || [ "$TAG_EXISTS" = "1" ]; then
  "$GH" auth status >/dev/null 2>&1 || die "not logged in to GitHub. Run:  $GH auth login"
fi
if [ "$TAG_EXISTS" = "1" ]; then
  if gh_cmd release view "$TAG" >/dev/null 2>&1; then
    [ "$REPLACE" = "1" ] || die "$TAG is already released on GitHub. Bump the version in manifest.json (or use --replace to redo this exact version)."
    REPLACING=1
    say "REPLACE: $TAG is already released; the tag will be moved to the new commit and the release recreated with the new xpi"
  else
    RESUME=1
    say "Tag $TAG is already pushed but has no GitHub release yet: only the release will be created"
  fi
fi

# ------------------------------------------------------------------ 2. xpi
say "Building $(basename "$XPI")"
mkdir -p "$OUT_DIR"
XPI_FILE_COUNT="$(python3 - "$REPO" "$XPI" "$VERSION" <<'PY'
import json
import os
import sys
import time
import zipfile

repo, out, version = sys.argv[1:4]
INCLUDE_DIRS = ["app", "dependencies", "images", "lib", "THIRD_PARTY_LICENSES"]
INCLUDE_FILES = ["manifest.json", "LICENSE", "NOTICE.md"]
SKIP_NAMES = {".DS_Store", "Thumbs.db"}
SKIP_SUFFIXES = (".pyc", ".bak", ".tmp")

names = []
for name in INCLUDE_FILES:
    if os.path.isfile(os.path.join(repo, name)):
        names.append(name)
for directory in INCLUDE_DIRS:
    for root, dirs, files in os.walk(os.path.join(repo, directory)):
        dirs[:] = sorted(d for d in dirs if d not in ("__pycache__", "node_modules"))
        for file in sorted(files):
            if file in SKIP_NAMES or file.endswith(SKIP_SUFFIXES):
                continue
            names.append(os.path.relpath(os.path.join(root, file), repo).replace(os.sep, "/"))

# A zip cannot store a time before 1980, and some files carry older times (copies
# made with the original file dates), so clamp each file's time to 1980-01-01.
EARLIEST = 315619200  # 1980-01-02 UTC: still 1980 in every time zone


def entry(path, name):
    when = time.localtime(max(os.stat(path).st_mtime, EARLIEST))
    info = zipfile.ZipInfo(name, date_time=when[:6])
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    return info


tmp = out + ".part"
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
    for name in names:
        path = os.path.join(repo, name)
        with open(path, "rb") as handle:
            zf.writestr(entry(path, name), handle.read())
os.replace(tmp, out)

# Verify what was written.
with zipfile.ZipFile(out) as zf:
    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    assert manifest["version"] == version, "xpi manifest version differs"
    assert zf.testzip() is None, "xpi is corrupt"
    assert all("\\" not in n for n in zf.namelist()), "backslash in an entry name"
print(len(names))
PY
)"
echo "    $XPI ($XPI_FILE_COUNT files, $(du -h "$XPI" | cut -f1))"

# ---------------------------------------------------- 3. notes and changelog
NOTES_IN_REPO="release-notes/$(basename "$NOTES")"
PLAN_NOTES="would copy the notes to $NOTES_IN_REPO and add them to CHANGELOG.md"
if [ "$DRY_RUN" = "0" ] && [ "$RESUME" = "0" ]; then
  mkdir -p release-notes
  [ "$NOTES" = "$REPO/$NOTES_IN_REPO" ] || cp "$NOTES" "$NOTES_IN_REPO"
  python3 - "$NOTES_IN_REPO" "$VERSION" <<'PY'
import datetime
import re
import sys

notes_path, version = sys.argv[1:3]
notes = open(notes_path, encoding="utf-8").read().replace("\r\n", "\n").strip("\n")
changelog = "CHANGELOG.md"
try:
    text = open(changelog, encoding="utf-8").read().replace("\r\n", "\n")
except FileNotFoundError:
    text = "# Changelog\n"

if re.search(r"^##\s+v?%s\b" % re.escape(version), text, re.M):
    print("    CHANGELOG.md already has a section for %s; left as it is" % version)
else:
    section = notes if notes.lstrip().startswith("## ") else "## %s - %s\n\n%s" % (
        version, datetime.date.today().isoformat(), notes)
    head, sep, rest = text.partition("\n")
    text = head + "\n\n" + section.strip("\n") + "\n\n" + rest.lstrip("\n")
    open(changelog, "w", encoding="utf-8", newline="\n").write(text.rstrip("\n") + "\n")
    print("    added %s to CHANGELOG.md" % version)
PY
fi

# --------------------------------------------------------------- 4. summary
say "Summary"
if [ "$DRY_RUN" = "0" ] && [ "$RESUME" = "0" ]; then
  # Make line endings consistent so the commit shows real changes only.
  # Third-party license texts are kept exactly as they were published.
  if ! grep -qs 'eol=lf' .gitattributes 2>/dev/null; then
    printf '* text=auto eol=lf\nTHIRD_PARTY_LICENSES/** -text\n' >> .gitattributes
  fi
  git add --renormalize . >/dev/null
  git add -A
fi
KIND="release"; [ "$PRERELEASE" = "1" ] && KIND="PRE-RELEASE"
echo "    version:   $VERSION   (tag $TAG on branch $BRANCH)   type: $KIND"
echo "    xpi:       $(basename "$XPI")"
echo "    notes:     $(basename "$NOTES") ($(wc -l < "$NOTES") lines) - first line: $(head -n 1 "$NOTES")"
if [ "$RESUME" = "1" ]; then
  echo "    resuming:  the code and tag $TAG are already on GitHub; only the release will be created"
else
  echo "    changes:"
  if [ "$DRY_RUN" = "0" ]; then
    git status --short | sed 's/^/        /'
    echo "    $(git diff --cached --shortstat)"
  else
    git status --short | sed 's/^/        /'
    echo "        ($PLAN_NOTES)"
  fi
fi

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run: nothing was committed, tagged, pushed or released."
  exit 0
fi

if [ "$ASSUME_YES" = "0" ]; then
  printf '\nPublish %s to GitHub now as a %s? [y/N] ' "$TAG" "$KIND"
  read -r answer < /dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) ;; *) say "Cancelled. Nothing was committed (changes are staged; 'git reset' undoes that)."; exit 1 ;; esac
fi

# --------------------------------------------- 5. commit, tag, push, release
if [ "$RESUME" = "0" ]; then
  say "Committing"
  if [ "$REPLACING" = "1" ]; then
    git diff --cached --quiet && die "nothing has changed since $TAG was published, so there is nothing to replace."
    git commit --quiet -m "Update $VERSION: changes made before it was signed" -m "$(head -n 1 "$NOTES" | sed 's/^#* *//')"
    git tag -f -a "$TAG" -m "Update Scanner Reborn $TAG" >/dev/null
  else
    git commit --quiet -m "Release $VERSION" -m "$(head -n 1 "$NOTES" | sed 's/^#* *//')"
    git tag -a "$TAG" -m "Update Scanner Reborn $TAG"
  fi

  say "Pushing"
  git_remote push "$REMOTE" "$BRANCH" || die "push failed. Your commit and tag are saved locally; fix the problem and run this command again."
  if [ "$REPLACING" = "1" ]; then
    git_remote push --force "$REMOTE" "$TAG"
    say "Removing the old GitHub release $TAG"
    gh_cmd release delete "$TAG" --yes || die "could not delete the old release. The code and the moved tag are pushed: run the same command again."
  else
    git_remote push "$REMOTE" "$TAG"
  fi
fi

say "Creating the GitHub release"
RELEASE_ARGS=(--title "$TAG" --notes-file "$(native_path "$NOTES")")
[ "$PRERELEASE" = "1" ] && RELEASE_ARGS+=(--prerelease)
gh_cmd release create "$TAG" "$(native_path "$XPI")" "${RELEASE_ARGS[@]}" \
  || die "the release could not be created. The code and tag are already pushed: run the same command again to retry only the release."

say "Done."
gh_cmd release view "$TAG" --json url --jq .url
