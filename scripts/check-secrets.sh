#!/bin/sh
# Fails if any secret value from .env (vars named *KEY, *PK, *SECRET, *PASSWORD, *TOKEN)
# appears in git history, staged changes, or any non-ignored file. Never prints the value.
# Install as pre-commit hook: ln -sf ../../scripts/check-secrets.sh .git/hooks/pre-commit
cd "$(git rev-parse --show-toplevel)" || exit 1
[ -f .env ] || exit 0
pat=$(mktemp) || exit 1
trap 'rm -f "$pat"' EXIT
grep -E '^[A-Z0-9_]*(KEY|PK|SECRET|PASSWORD|TOKEN)=' .env | cut -d= -f2- \
  | sed "s/^[\"']//; s/[\"']\$//" | awk 'length >= 8' > "$pat"
[ -s "$pat" ] || exit 0
fail=0
git log -p --all 2>/dev/null | grep -qF -f "$pat" && { echo "check-secrets: .env secret found in git history"; fail=1; }
git diff --cached | grep -qF -f "$pat" && { echo "check-secrets: .env secret found in staged changes"; fail=1; }
git grep --untracked -lF -f "$pat" -- . && { echo "check-secrets: .env secret found in the files above"; fail=1; }
[ "$fail" = 0 ] && echo "check-secrets: ok"
exit "$fail"
