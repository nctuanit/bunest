# syntax=docker/dockerfile:1.7
# Multi-stage production image for Bunest 0.1 Production Preview.
# Build from repository root:
#   docker build -f examples/production-rest-postgres/Dockerfile \
#     --build-arg APP_VERSION=0.1.0-preview \
#     -t bunest-prod-preview:0.1.0-preview .

FROM oven/bun:1.4.5-alpine AS builder
WORKDIR /workspace

COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
# Copy minimal workspace manifests for apps/* and sibling examples/* so
# `bun install --frozen-lockfile` matches root workspaces without pulling in
# unrelated app/example sources.
COPY apps/docs/package.json ./apps/docs/
COPY apps/playground/package.json ./apps/playground/
COPY apps/vscode-bunest/package.json ./apps/vscode-bunest/
COPY examples/auth-jwt-sqlite/package.json ./examples/auth-jwt-sqlite/
COPY examples/distributed-worker/package.json ./examples/distributed-worker/
COPY examples/hello-world/package.json ./examples/hello-world/
COPY examples/rest-crud/package.json ./examples/rest-crud/
COPY examples/starter/package.json ./examples/starter/
COPY examples/vscode-extension-showcase/package.json ./examples/vscode-extension-showcase/
COPY examples/websocket-chat/package.json ./examples/websocket-chat/
COPY packages ./packages
COPY examples/production-rest-postgres ./examples/production-rest-postgres

RUN bun install --frozen-lockfile \
  && bun run --cwd examples/production-rest-postgres build

FROM oven/bun:1.4.5-alpine AS runtime
ARG APP_VERSION=0.1.0-preview

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_VERSION=${APP_VERSION} \
    SHUTDOWN_READINESS_DELAY_MS=3000 \
    SHUTDOWN_DRAIN_TIMEOUT_MS=10000

WORKDIR /app
COPY --from=builder --chown=bun:bun /workspace/examples/production-rest-postgres/dist ./dist
COPY --from=builder --chown=bun:bun /workspace/examples/production-rest-postgres/package.json ./package.json

# Run strictly as non-root user
USER bun
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3000/live'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "dist/main.js"]
