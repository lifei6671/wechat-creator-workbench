.DEFAULT_GOAL := help

.PHONY: help build-desktop build-server

help:
	@echo "make build-desktop  安装依赖并构建可直接打开的 macOS .app"
	@echo "make build-server   安装依赖并构建后端同步服务"
	@echo "需要 Node.js 24、pnpm 和 Rust；桌面构建还需对应平台的构建工具，详见 README.md。"

build-desktop:
	pnpm install --frozen-lockfile
	pnpm build --bundles app

build-server:
	npm ci --prefix apps/sync-server
	npm run build --prefix apps/sync-server
