SHELL := /bin/bash

.PHONY: dev dev-deps down test lint typecheck docs release-check audit audit-fix

dev-deps:
	npm --prefix signaling ci
	npm --prefix media ci
	npm --prefix webapp ci

dev:
	docker compose -f containerization/docker-compose.yml up --build webapp signaling ingress egress

down:
	docker compose -f containerization/docker-compose.yml down

test:
	cd signaling && npm run test:all
	cd media && npm run test

lint:
	cd signaling && npm run lint
	cd media && npm run lint
	cd webapp && npm run lint

typecheck:
	cd signaling && npm run typecheck
	cd media && npm run typecheck
	cd webapp && npm run typecheck

docs:
	cd signaling && npm run docs
	cd media && npm run docs
	cd webapp && npm run docs

release-check:
	$(MAKE) lint
	$(MAKE) typecheck
	$(MAKE) test


audit:
	@echo "Running npm audit for signaling/media/webapp..."
	npm --prefix signaling audit
	npm --prefix media audit
	npm --prefix webapp audit


audit-fix:
	@echo "Running npm audit fix for signaling/media/webapp..."
	npm --prefix signaling audit fix
	npm --prefix media audit fix
	npm --prefix webapp audit fix
