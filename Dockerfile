FROM oven/bun:1.4-slim
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# src/wasm/ holds the prebuilt iroh-gossip module, so no Rust toolchain is needed here.
COPY tsconfig.json ./
COPY src ./src
# `bun run hash-password` works inside the container too.
COPY scripts/hash-password.ts ./scripts/

ENV NODE_ENV=production \
    PORT=3000 \
    AUDIA_SESSION_FILE=/app/data/session.json
RUN mkdir -p /app/data
VOLUME /app/data
EXPOSE 3000

CMD ["bun", "src/server.ts"]
