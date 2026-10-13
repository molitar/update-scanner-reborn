#!/usr/bin/env bash
# Publish Update Scanner Reborn from your PC (WSL), so the server never talks to GitHub.
#
# Usage (from WSL):
#   publish.sh NOTES.md [--prerelease] [--replace] [--yes] [--dry-run] [--no-sync-back]
#
# The editing happens on the server (strix), as before: bump the version in
# manifest.json and write release-notes/<version>.md there. This script then:
#   1. keeps a clean clone of the GitHub repository on this PC,
#   2. copies the current working files from the server into that clone,
#   3. runs tools/publish-release.sh in the clone (build, commit, tag, push, release;
#      GitHub is contacted from this PC only, using the Windows GitHub CLI login),
#   4. copies the result back to the server (its .git is backed up first), so the
#      server's copy is up to date with what was published.
#
# Options besides those of publish-release.sh:
#   --no-sync-back   do not update the server's copy afterwards
#
# Settings (environment variables, defaults in brackets):
#   STRIX_SPEC   where the working files are [siw@192.168.1.15:github/update-scanner-reborn]
#   PUBLISH_DIR  where the clone lives on this PC [~/update-scanner-publish]
#   XPI_OUT_DIR  where the built xpi is written [/mnt/c/Renamers/update-scanner-builds/release]
#   REPO_URL     the GitHub repository [https://github.com/molitar/update-scanner-reborn.git]

set -euo pipefail

STRIX_SPEC="${STRIX_SPEC:-siw@192.168.1.15:github/update-scanner-reborn}"
WORK="${PUBLISH_DIR:-$HOME/update-scanner-publish}"
CLONE="$WORK/repo"
REPO_URL="${REPO_URL:-https://github.com/molitar/update-scanner-reborn.git}"
export XPI_OUT_DIR="${XPI_OUT_DIR:-/mnt/c/Renamers/update-scanner-builds/release}"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }

ARGS=()
SYNC_BACK=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-sync-back) SYNC_BACK=0 ;;
    --dry-run|-n) DRY_RUN=1; ARGS+=("$arg") ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$arg") ;;
  esac
done
[ ${#ARGS[@]} -gt 0 ] || die "give the release notes file, e.g.  publish.sh 5.1.0.md --prerelease"

# The server may be a remote spec (user@host:path) or a plain local folder (for tests).
case "$STRIX_SPEC" in
  /*|./*) STRIX_HOST=""; STRIX_PATH="$STRIX_SPEC" ;;
  *:*)    STRIX_HOST="${STRIX_SPEC%%:*}"; STRIX_PATH="${STRIX_SPEC#*:}" ;;
  *)      STRIX_HOST=""; STRIX_PATH="$STRIX_SPEC" ;;
esac
on_strix() {
  if [ -n "$STRIX_HOST" ]; then ssh -o BatchMode=yes -o ConnectTimeout=10 "$STRIX_HOST" "$1"; else bash -c "$1"; fi
}
strix_url() { if [ -n "$STRIX_HOST" ]; then printf '%s:%s' "$STRIX_HOST" "$STRIX_PATH"; else printf '%s' "$STRIX_PATH"; fi; }

for tool in git rsync python3; do command -v "$tool" >/dev/null || die "$tool is not installed"; done
GH=gh
if ! command -v gh >/dev/null && command -v gh.exe >/dev/null; then GH=gh.exe; fi
command -v "$GH" >/dev/null || die "the GitHub CLI is not installed (neither gh nor gh.exe)"
GIT_AUTH=()
if [ "$GH" = "gh.exe" ]; then GIT_AUTH=(-c "credential.helper=" -c "credential.helper=!gh.exe auth git-credential"); fi
git_remote() { git ${GIT_AUTH[@]+"${GIT_AUTH[@]}"} "$@"; }

on_strix "test -f '$STRIX_PATH/manifest.json'" || die "cannot reach the working files at $STRIX_SPEC (is the server on?)"

# ------------------------------------------------ 1. a clean clone of GitHub
mkdir -p "$WORK"
if [ ! -d "$CLONE/.git" ]; then
  say "First run: cloning $REPO_URL"
  git_remote clone --quiet "$REPO_URL" "$CLONE" || die "could not clone the repository"
fi
say "Refreshing the clone from GitHub"
git_remote -C "$CLONE" fetch --quiet origin main --tags || die "could not reach GitHub"
git -C "$CLONE" checkout --quiet -B main origin/main
git -C "$CLONE" reset --quiet --hard origin/main
git -C "$CLONE" clean --quiet -fd

NAME="$(on_strix "git -C '$STRIX_PATH' config user.name" 2>/dev/null || true)"
EMAIL="$(on_strix "git -C '$STRIX_PATH' config user.email" 2>/dev/null || true)"
[ -z "$NAME" ] || git -C "$CLONE" config user.name "$NAME"
[ -z "$EMAIL" ] || git -C "$CLONE" config user.email "$EMAIL"
git -C "$CLONE" config user.name >/dev/null || die "no git user name: set one on the server (git config user.name) or here"

# ------------------------------------- 2. the working files from the server
say "Copying the working files from $STRIX_SPEC"
# --checksum compares file contents, not just size and time, so an edit is never missed.
CHANGED="$(rsync -a --checksum --delete --exclude='/.git/' --itemize-changes "$(strix_url)/" "$CLONE/" | grep -c '^[<>c*]' || true)"
echo "    $CHANGED file(s) differ from what is on GitHub's side of the clone"

# ------------------------------------------------- 3. build, commit, publish
STATUS=0
bash "$CLONE/tools/publish-release.sh" "${ARGS[@]}" || STATUS=$?
[ "$STATUS" = "0" ] || { echo; echo "Publishing stopped (exit $STATUS). Nothing was changed on the server."; exit "$STATUS"; }
[ "$DRY_RUN" = "0" ] || exit 0

# --------------------------------------------- 4. bring the server up to date
if [ "$SYNC_BACK" = "1" ]; then
  say "Updating the server's copy (its .git is backed up first)"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  on_strix "cp -a '$STRIX_PATH/.git' '$STRIX_PATH.git.backup-$STAMP'" || die "could not back up the server's .git; it was NOT changed"
  # Files that are in the published commit but not on the server (for example
  # .gitattributes, which the first publish creates) were removed from the clone by the
  # copy above; put them back so the server gets them too.
  MISSING="$(git -C "$CLONE" ls-files -d)"
  [ -z "$MISSING" ] || git -C "$CLONE" checkout -- $MISSING
  rsync -a --checksum --delete "$CLONE/.git/" "$(strix_url)/.git/"
  rsync -a --checksum --exclude='/.git/' "$CLONE/" "$(strix_url)/"
  echo "    backup: $STRIX_PATH.git.backup-$STAMP"
  echo "    server working tree now: $(on_strix "git -C '$STRIX_PATH' status --short | wc -l") changed file(s) according to git"
fi
say "All done."
