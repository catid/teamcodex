FROM oven/bun:1.4.2 AS dependencies
WORKDIR /dependencies
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/proxy/package.json ./packages/proxy/package.json
RUN bun install --production --frozen-lockfile

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY packages/core/package.json ./packages/core/package.json
COPY packages/core/src/ ./packages/core/src/
COPY packages/proxy/package.json ./packages/proxy/package.json
COPY packages/proxy/src/ ./packages/proxy/src/
COPY --from=dependencies /dependencies/node_modules/ ./node_modules/
# Host files may be owner-only; Compose runs with the host user's numeric UID.
RUN chmod -R a+rX /app
USER node
EXPOSE 1456
ENTRYPOINT ["node", "src/index.js"]
CMD ["serve"]
