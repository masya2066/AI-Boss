# DevPilot worker/API image. The container itself is the isolation boundary for
# agents: unprivileged user, only /data (worktrees) and /repos mounted, no Docker
# socket. Gate commands therefore run locally inside this container.
FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/gh.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && useradd -m -u 10001 devpilot && mkdir -p /data /repos && chown devpilot /data
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci --no-audit --no-fund
COPY agents ./agents
COPY policies ./policies
COPY scripts ./scripts
COPY tsconfig.json ./
ENV DEVPILOT_IN_CONTAINER=1 DEVPILOT_DATA_DIR=/data NODE_ENV=production
USER devpilot
# Subscription auth inside the container: pass CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`).
CMD ["npx", "tsx", "apps/worker/src/main.ts"]
