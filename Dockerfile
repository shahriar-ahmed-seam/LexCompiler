# --- build stage: compile the React client and the TypeScript server ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime stage: production dependencies only, non-root ---
FROM node:22-bookworm-slim
# python3: Python AST analysis and the optional runtime sandbox; git: sandbox history and repo identity
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# OPA evaluates the generated Rego policies (LEXCOMPILER_OPA_BIN defaults to `opa` on PATH)
COPY --from=openpolicyagent/opa:1.4.2-static /opa /usr/local/bin/opa

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    LEXCOMPILER_DATA_DIR=/app/data

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Real FastAPI / Pydantic / Redis client libraries for the runtime sandbox
COPY requirements-sandbox.txt ./
RUN python3 -m venv /app/.venv && /app/.venv/bin/pip install --no-cache-dir -q -r requirements-sandbox.txt
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY target-repo ./target-repo
COPY integrations ./integrations
RUN mkdir -p /app/data && chown -R node:node /app/data /app/target-repo

USER node
EXPOSE 3001
# Ledger, signing key, sandbox git history, and persisted clauses live here.
VOLUME ["/app/data"]

# The server refuses to start on 0.0.0.0 unless LEXCOMPILER_API_TOKEN is provided at runtime.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
