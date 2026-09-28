#!/bin/sh
# Fails if any secret value from .env (vars named *KEY, *PK, *SECRET, *PASSWORD, *TOKEN, *MNEMONIC,
# any case, optional "export", quotes, CRLF, inline comments) appears in git history, staged changes,
# any non-ignored file, or the ignored build/log dirs. Never prints the value.
# Install as pre-commit hook: ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit
cd "$(git rev-parse --show-toplevel)" || exit 1
[ -f .env ] || { echo "check-secrets: no .env, nothing to check"; exit 0; }
pat=$(mktemp) || exit 1
trap 'rm -f "$pat"' EXIT
tr -d '\r' < .env \
  | grep -iE '^[[:space:]]*(export[[:space:]]+)?[a-z0-9_]*(key|pk|secret|password|token|mnemonic)[[:space:]]*=' \
  | sed -E 's/^[^=]*=[[:space:]]*//; s/^"([^"]*)".*$/\1/; s/^'"'"'([^'"'"']*)'"'"'.*$/\1/; s/[[:space:]]+#.*$//; s/[[:space:]]+$//' \
  | awk 'length >= 8' > "$pat"
[ -s "$pat" ] || { echo "check-secrets: no secret-named vars in .env, nothing checked"; exit 0; }
fail=0
git log -p --all --text 2>/dev/null | grep -qF -f "$pat" && { echo "check-secrets: .env secret found in git history"; fail=1; }
git diff --cached --text | grep -qF -f "$pat" && { echo "check-secrets: .env secret found in staged changes"; fail=1; }
git grep --untracked -lF -f "$pat" -- . && { echo "check-secrets: .env secret found in the files above"; fail=1; }
for d in logs dist; do
  [ -d "$d" ] && grep -rlF -f "$pat" "$d" && { echo "check-secrets: .env secret found in $d/"; fail=1; }
done
[ "$fail" = 0 ] && echo "check-secrets: ok"
exit "$fail"
