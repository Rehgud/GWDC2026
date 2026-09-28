#!/usr/bin/env bash
# check-secrets.sh — fail if a real secret from .env (or a Kiln key) leaked.
#
# Where it looks (T1, S3-1/S9-2):
#   1. staged diff (what is about to be committed)
#   2. working tree: tracked + untracked-but-not-ignored files (.env.example included)
#   3. evidence/log dirs even if ignored: runs/ logs/ dist/
#   4. full history: git log -p --all
#
# What it looks for:
#   - the exact value (grep -F) of every .env entry whose NAME looks secret
#     (*_PK, *_KEY, *PRIVATE*, *SECRET*, *TOKEN*, *PASSWORD*)
#   - the Kiln key prefix pattern sk-bk-<alnum> anywhere
#
# Well-known public anvil dev keys are allowed (they appear in local e2e scripts).
# The script never prints a secret value, only the variable name and location.
#
# Implementation note: large texts (staged diff, git log -p) are written to temp files and
# grepped as FILES. Never `printf "$big" | grep -q` under pipefail: grep -q exits on the first
# match, printf dies of SIGPIPE, and pipefail turns the match into a miss.
# Portable to bash 3.2 (no mapfile, no empty-array expansion under set -u).
set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env}"
fail=0

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t check-secrets)"
trap 'rm -rf "$TMP"' EXIT

# anvil default mnemonic accounts 0..9 (public, safe to appear anywhere)
ANVIL_KEYS="
0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356
0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6
"

is_anvil_key() {
  v="${1#0x}"
  for k in $ANVIL_KEYS; do
    [ "${k#0x}" = "$v" ] && return 0
  done
  return 1
}

report() { # $1 = where, $2 = what
  echo "check-secrets: FAIL — $2 found in $1" >&2
  fail=1
}

# ---- collect secret values from .env into $TMP/names + $TMP/values (one per line) --------
: > "$TMP/names"
: > "$TMP/values"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|\#*) continue ;; esac
    name="${line%%=*}"
    value="${line#*=}"
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    [ -z "$value" ] && continue
    upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
    case "$upper" in
      *_PK|*_KEY|*PRIVATE*|*SECRET*|*TOKEN*|*PASSWORD*) ;;
      *) continue ;;
    esac
    # too short to be a real secret; grepping it would only produce noise
    [ "${#value}" -lt 12 ] && continue
    is_anvil_key "$value" && continue
    printf '%s\n' "$name" >> "$TMP/names"
    printf '%s\n' "$value" >> "$TMP/values"
  done < "$ENV_FILE"
fi
nvalues="$(wc -l < "$TMP/values" | tr -d ' ')"

# ---- file list: tracked + untracked-not-ignored (only .env itself excluded) + evidence dirs --
git ls-files -co --exclude-standard | grep -v -x -F '.env' > "$TMP/files" || true
for d in runs logs dist; do
  if [ -d "$d" ]; then find "$d" -type f >> "$TMP/files"; fi
done
nfiles="$(wc -l < "$TMP/files" | tr -d ' ')"

# ---- big texts as files -------------------------------------------------------------------
git diff --cached -U0 --no-color > "$TMP/staged" 2>/dev/null || : > "$TMP/staged"
if git rev-parse --verify -q HEAD >/dev/null; then
  git log -p --all --no-color > "$TMP/history" 2>/dev/null || : > "$TMP/history"
else
  : > "$TMP/history"
fi

KILN_RE='sk-bk-[A-Za-z0-9]{8,}'

# ---- 1..4: exact secret values -----------------------------------------------------------------
i=0
while IFS= read -r v; do
  i=$((i + 1))
  n="$(sed -n "${i}p" "$TMP/names")"
  if grep -q -F -- "$v" "$TMP/staged"; then report "staged changes" "value of $n"; fi
  if grep -q -F -- "$v" "$TMP/history"; then report "git history (git log -p --all)" "value of $n"; fi
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    if grep -q -F -- "$v" "$f" 2>/dev/null; then report "$f" "value of $n"; fi
  done < "$TMP/files"
done < "$TMP/values"

# ---- Kiln key pattern ------------------------------------------------------------------------
# this script documents the pattern itself (KILN_RE=...), so lines containing it are excluded
if grep -E -- "$KILN_RE" "$TMP/staged" | grep -q -v -F 'KILN_RE='; then
  report "staged changes" "Kiln key pattern sk-bk-*"
fi
if grep -E -- "$KILN_RE" "$TMP/history" > "$TMP/kiln_hist" 2>/dev/null && grep -q -v -F 'KILN_RE=' "$TMP/kiln_hist"; then
  report "git history (git log -p --all)" "Kiln key pattern sk-bk-*"
fi
while IFS= read -r f; do
  [ -f "$f" ] || continue
  [ "$f" = "scripts/check-secrets.sh" ] && continue
  if grep -q -E -- "$KILN_RE" "$f" 2>/dev/null; then report "$f" "Kiln key pattern sk-bk-*"; fi
done < "$TMP/files"

# ---- .env must be ignored ------------------------------------------------------------------------
if ! git check-ignore -q .env; then
  report ".gitignore" ".env is NOT ignored"
fi

if [ "$fail" -ne 0 ]; then
  echo "check-secrets: remove the secret, rotate it, and retry." >&2
  exit 1
fi
echo "check-secrets: PASS (${nvalues} secret value(s) checked, ${nfiles} file(s) scanned)"
