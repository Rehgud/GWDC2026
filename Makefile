# Thin wrappers around npm scripts (Windows machines without make: run the npm script directly).
# The five commands: deploy -> run -> wind-down -> audit, and health at any time.
.PHONY: test test-sol test-ts deploy preflight sign-spec run wind-down audit health e2e-local crash-test report smoke-kiln eval-f2 nothink check-secrets check-iface anvil

test: test-sol test-ts

test-sol:
	forge test

test-ts:
	npm test

# forge test -> MockUSDC -> mint -> Vault -> approve -> fund(X, deadline) -> setVendor x4 -> setMaxHold
# -> deployments/<chainId>-<vault>.json + current.json -> preflight   (then: make sign-spec)
deploy:
	npm run deploy

preflight:
	npm run preflight

sign-spec:
	npm run sign-spec

# one session on the current vault; SCENARIO=normal|qwen-deny|injection|stolen-key|stop|deadline|migration|migration-d3|nan|plateau|budget
run:
	npm run session -- --scenario $${SCENARIO:-normal} --serve

# founder-only escape hatch: delta settle -> close all (INFERENCE too) -> refund, continuing the record chain
wind-down:
	npm run wind-down

# BUNDLE=runs/<vault> ; exit 0 PASS / 1 FAIL / 2 CANNOT_VERIFY
audit:
	npm run audit -- $${BUNDLE}

health:
	npm run health

e2e-local:
	npm run e2e:local

crash-test:
	npm run crash:test

report:
	npm run report -- $${BUNDLE}

smoke-kiln:
	npm run smoke:kiln

eval-f2:
	npm run eval:f2

nothink:
	npm run nothink

check-secrets:
	npm run check-secrets

# [IFACE] drift check: regenerated ABI and fixtures must equal the committed ones
check-iface:
	npm run gen:abi && npm run gen:fixtures && git diff --exit-code -- backend/abi.ts fixtures/

anvil:
	npm run anvil
