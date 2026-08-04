#!/usr/bin/env bash
# Bump every version surface, then PROVE none was missed.
#
# Usage: ./scripts/bump-version.sh <version> [--commit] [--tag] [--skip-tests]
#
#   --commit      also `git add` the version surfaces and commit them
#   --tag         also create the vX.Y.Z tag (implies --commit)
#   --skip-tests  don't run the suite for the README "tests passing" badge
#
# By DEFAULT this script only edits files. It does not touch git.
#
# Why: the previous version ran `git add -A && git commit && git tag`
# unconditionally, which swept whatever else was in the working tree into the
# bump commit. That breaks the QA-BEFORE-BUMP rule — content fixes are supposed
# to be committed (and QA'd) first, with the bump as its own final commit — and
# on the v0.8.5 release it silently squashed ten unrelated fixes into
# "chore: bump to v0.8.5".
#
# The other historical failure was a staleness check that only verified the
# surfaces the script already knew about, which is self-fulfilling: it cannot
# discover a surface nobody wired in. v0.8.5 shipped with package-lock.json and
# src/mcp-server.ts still on the old version while the script printed a green
# summary. The check below now sweeps the repo for the OLD version instead, so
# an unknown surface fails the run rather than passing silently.

set -euo pipefail

VERSION=""
DO_COMMIT=0
DO_TAG=0
SKIP_TESTS=0

for arg in "$@"; do
  case "$arg" in
    --commit) DO_COMMIT=1 ;;
    --tag) DO_TAG=1; DO_COMMIT=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    -*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *) if [ -z "$VERSION" ]; then VERSION="$arg"; else echo "Unexpected arg: $arg" >&2; exit 2; fi ;;
  esac
done

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version> [--commit] [--tag] [--skip-tests]"
  echo "Example: $0 0.8.6 --commit --tag"
  exit 1
fi

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  echo "ERROR: '${VERSION}' is not a semver version (expected e.g. 1.2.3 or 1.2.3-rc1)." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TODAY=$(date +%Y-%m-%d)
CHANGELOG="$ROOT/CHANGELOG.md"

OLD_VERSION=$(grep -m1 '"version"' "$ROOT/package.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')
if [ -z "$OLD_VERSION" ]; then
  echo "ERROR: could not read the current version from package.json." >&2
  exit 1
fi

echo "Bumping ${OLD_VERSION} -> ${VERSION}"
if [ "$OLD_VERSION" = "$VERSION" ]; then
  echo "  (same version — re-running to re-verify surfaces)"
fi

# --- CHANGELOG gate -------------------------------------------------------
# A release with no notes silently falls back to GitHub's auto-generated ones
# (build-release.yml greps for "## [<version>]"), so this is a hard gate.
if grep -q "## \[${VERSION}\]" "$CHANGELOG"; then
  echo "  CHANGELOG: section [${VERSION}] present"
else
  UNRELEASED_CONTENT=$(sed -n '/^## \[Unreleased\]/,/^## \[/{/^## \[/d;/^$/d;p;}' "$CHANGELOG")
  if [ -n "$UNRELEASED_CONTENT" ]; then
    echo "  CHANGELOG: promoting [Unreleased] -> [${VERSION}] - ${TODAY}"
    sed -i "s/^## \[Unreleased\]/## [Unreleased]\n\n## [${VERSION}] - ${TODAY}/" "$CHANGELOG"
  else
    echo ""
    echo "  ERROR: CHANGELOG.md has no [${VERSION}] section and [Unreleased] is empty."
    echo "  Document what changed before bumping."
    echo ""
    exit 1
  fi
fi

VERSION_SURFACES=(
  "package.json"
  "package-lock.json"
  ".claude-plugin/plugin.json"
  "README.md"
  "CHANGELOG.md"
  "src/mcp-client/index.ts"
  "src/mcp-server.ts"
)

# --- Working-tree gate (only when we intend to commit) --------------------
# Refuse to fold unrelated work into a bump commit. The bump must be the last
# commit before the tag, containing nothing but version surfaces.
if [ "$DO_COMMIT" = "1" ]; then
  DIRTY=$(cd "$ROOT" && git status --porcelain --untracked-files=no | awk '{print $2}')
  UNRELATED=""
  for f in $DIRTY; do
    keep=0
    for s in "${VERSION_SURFACES[@]}"; do [ "$f" = "$s" ] && keep=1; done
    # dist/ is regenerated below and rides along with whichever commit rebuilt it
    case "$f" in dist/*) keep=1 ;; esac
    [ "$keep" = "0" ] && UNRELATED="${UNRELATED}  ${f}\n"
  done
  if [ -n "$UNRELATED" ]; then
    echo ""
    echo "  ERROR: uncommitted changes outside the version surfaces:"
    printf "%b" "$UNRELATED"
    echo "  Commit your content changes FIRST (QA-BEFORE-BUMP), then bump."
    echo "  Or drop --commit/--tag and commit by hand."
    echo ""
    exit 1
  fi
fi

# --- Surface 1: package.json ---------------------------------------------
# Anchored to the FIRST "version" key so a nested one can't be hit.
sed -i "0,/\"version\": \"[^\"]*\"/s//\"version\": \"${VERSION}\"/" "$ROOT/package.json"

# --- Surface 2: package-lock.json (TWO refs) -----------------------------
# Never blanket-sed this file: it is full of dependency version strings and a
# global replace corrupts them. Only the top-level "version" and the
# packages."" entry describe THIS package.
node - "$ROOT/package-lock.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [file, version] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(file, "utf8"));
lock.version = version;
if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
fs.writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
NODE

# --- Surface 3: .claude-plugin/plugin.json -------------------------------
sed -i "0,/\"version\": \"[^\"]*\"/s//\"version\": \"${VERSION}\"/" "$ROOT/.claude-plugin/plugin.json"

# --- Surface 4: README.md version badge ----------------------------------
sed -i -E "s|badge/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?-stable|badge/v${VERSION}-stable|" "$ROOT/README.md"

# --- Surface 5: CLIENT_VERSION -------------------------------------------
sed -i "s/const CLIENT_VERSION = \"[^\"]*\"/const CLIENT_VERSION = \"${VERSION}\"/" "$ROOT/src/mcp-client/index.ts"

# --- Surface 6: src/mcp-server.ts McpServer version ----------------------
# Historically the most-missed surface: earlier script versions skipped it
# entirely (see CHANGELOG for the release that fixed this).
sed -i -E "s/(name: \"laqrumcode\", version: \")[^\"]*(\")/\1${VERSION}\2/" "$ROOT/src/mcp-server.ts"

# DAEMON_VERSION in src/daemon/index.ts is intentionally absent: it reads
# package.json at runtime (or __LAQRUMCODE_VERSION__ injected at bundle time).

# --- README tests badge (optional; slow) ---------------------------------
if [ "$SKIP_TESTS" = "0" ]; then
  TEST_COUNT=$(cd "$ROOT" && npm test 2>&1 | grep -oP '\d+ passed' | tail -1 | grep -oP '\d+' || echo "")
  if [ -n "$TEST_COUNT" ]; then
    sed -i -E "s|Tests-[0-9]+_passing|Tests-${TEST_COUNT}_passing|" "$ROOT/README.md"
    echo "  Tests badge: ${TEST_COUNT} passing"
  fi
else
  echo "  Tests badge: skipped (--skip-tests)"
fi

# --- Rebuild dist/ (the daemon loads it at runtime) ----------------------
(cd "$ROOT" && npm run build >/dev/null)

# --- Verification A: every known surface now reads the NEW version -------
FAIL=""
check() { # <label> <file> <pattern>
  grep -q "$3" "$2" || FAIL="${FAIL}  ${1}\n"
}
check "package.json"            "$ROOT/package.json"                 "\"version\": \"${VERSION}\""
check "package-lock (top)"      "$ROOT/package-lock.json"            "\"version\": \"${VERSION}\""
check "plugin.json"             "$ROOT/.claude-plugin/plugin.json"   "\"version\": \"${VERSION}\""
check "README version badge"    "$ROOT/README.md"                    "badge/v${VERSION}-stable"
check "CLIENT_VERSION"          "$ROOT/src/mcp-client/index.ts"      "CLIENT_VERSION = \"${VERSION}\""
check "mcp-server.ts"           "$ROOT/src/mcp-server.ts"            "version: \"${VERSION}\""
check "CHANGELOG"               "$CHANGELOG"                         "## \[${VERSION}\]"

if ! node - "$ROOT/package-lock.json" "$VERSION" <<'NODE'
const fs = require("node:fs");
const [file, version] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(file, "utf8"));
process.exit(lock.packages?.[""]?.version === version ? 0 : 1);
NODE
then
  FAIL="${FAIL}  package-lock (packages[''])\n"
fi

if [ -n "$FAIL" ]; then
  echo ""
  echo "  ERROR: these surfaces did NOT take the new version:"
  printf "%b" "$FAIL"
  exit 1
fi

# --- Verification B: sweep for the OLD version --------------------------
# The check that actually matters. The previous script only verified surfaces
# it already knew about, so a surface nobody wired in stayed stale AND passed.
# Sweeping for the old string finds surfaces this script has never heard of.
#
# package-lock.json and dist/ are excluded: both legitimately contain unrelated
# version strings (dependency pins, bundled banners). Both are verified above /
# regenerated from source.
if [ "$OLD_VERSION" != "$VERSION" ]; then
  # Exclusions use grep's own flags rather than piping through `grep -v "^\./…"`:
  # grep does not reliably emit the "./" prefix, so path-anchored filters
  # silently matched nothing and the exclusions were dead.
  LEFTOVER=$(cd "$ROOT" && grep -rn --fixed-strings "$OLD_VERSION" \
      --include="*.json" --include="*.ts" --include="*.md" --include="*.mjs" --include="*.sh" \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
      --exclude=package-lock.json --exclude=CHANGELOG.md \
      . 2>/dev/null \
    | awk '{ c = $0; sub(/^[^:]*:[0-9]+:/, "", c); if (tolower(c) ~ /version|badge\/v/) print }' || true)
  # The awk strips the "path:line:" prefix before testing. Filtering the raw
  # grep output instead matches the FILENAME — every hit in this very script
  # passed the filter because its own path contains "version".
  # The trailing filter keeps the sweep useful in a codebase that documents its
  # own history. This repo is full of legitimate prose references ("v0.8.5
  # unified the session-id spaces"), and flagging those would train whoever
  # runs this to ignore the error. A real surface is an ASSIGNMENT, so the line
  # will carry the word "version" or a badge URL; a historical mention usually
  # will not. Heuristic, deliberately: it can miss an oddly-shaped surface, but
  # it does not cry wolf, and Verification A still covers all seven known ones.
  if [ -n "$LEFTOVER" ]; then
    echo ""
    echo "  ERROR: the old version ${OLD_VERSION} still appears here:"
    printf "%s\n" "$LEFTOVER" | sed 's/^/    /'
    echo ""
    echo "  If any of these is a real version surface, add it to this script"
    echo "  AND to the surface table in the laqrumcode-release skill."
    echo "  If it is a historical reference (a comment, a quoted example),"
    echo "  reword it so the sweep stays meaningful."
    exit 1
  fi
  echo "  Sweep: no stray ${OLD_VERSION} references outside CHANGELOG/dist/lock"
fi

echo ""
echo "  package.json:          ${VERSION}"
echo "  package-lock.json:     ${VERSION} (both refs)"
echo "  plugin.json:           ${VERSION}"
echo "  CLIENT_VERSION:        ${VERSION}"
echo "  mcp-server.ts:         ${VERSION}"
echo "  README badge:          v${VERSION}"
echo "  CHANGELOG:             [${VERSION}]"
echo "  DAEMON_VERSION:        dynamic (reads package.json)"
echo ""

if [ "$DO_COMMIT" = "1" ]; then
  (cd "$ROOT" && git add "${VERSION_SURFACES[@]}" dist 2>/dev/null || true)
  (cd "$ROOT" && git commit -m "chore: bump to v${VERSION}")
  echo "  Committed."
  if [ "$DO_TAG" = "1" ]; then
    (cd "$ROOT" && git tag "v${VERSION}")
    echo "  Tagged v${VERSION}."
    echo ""
    echo "Next: git push origin master && git push origin v${VERSION}"
    echo "      (push the commit BEFORE the tag, or the tag points at nothing)"
  else
    echo ""
    echo "Next: git tag v${VERSION} && git push origin master && git push origin v${VERSION}"
  fi
else
  echo "Files bumped. Nothing committed (pass --commit --tag to do that here)."
  echo ""
  echo "Next: git add -- ${VERSION_SURFACES[*]} dist"
  echo "      git commit -m 'chore: bump to v${VERSION}'"
  echo "      git tag v${VERSION}"
  echo "      git push origin master && git push origin v${VERSION}"
fi
