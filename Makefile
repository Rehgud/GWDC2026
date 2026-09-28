# Thin wrappers around npm scripts (Windows machines without make: run the npm script directly).
.PHONY: test test-sol test-ts deploy preflight sign-spec check-secrets check-iface anvil

test: test-sol test-ts

test-sol:
	forge test

test-ts:
	npm test

# forge test -> MockUSDC -> mint -> Vault -> approve -> fund(X, deadline) -> setVendor x4 -> setMaxHold
# -> deployments/<chainId>-<vault>.json + current.json -> preflight
deploy:
	npm run deploy

preflight:
	npm run preflight

sign-spec:
	npm run sign-spec

check-secrets:
	npm run check-secrets

# [IFACE] drift check: regenerated ABI and fixtures must equal the committed ones
check-iface:
	npm run gen:abi && npm run gen:fixtures && git diff --exit-code -- backend/abi.ts fixtures/

anvil:
	npm run anvil
