# syntax=docker/dockerfile:1
FROM oven/bun:1 AS base
WORKDIR /app

# dependency layer (cached unless package.json changes)
COPY package.json bun.lock* ./
RUN bun install --production

# runtime: copy source + static assets
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# persistent state lives here
VOLUME /data
ENV BOOKMARKER_DB=/data/bookmarker.db
ENV PORT=3000

EXPOSE 3000
# runs as root so the /data volume is writable; the container serves a single
# purpose app with no shell exposure, so this is the pragmatic default
CMD ["bun", "src/server.ts"]
