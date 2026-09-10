FROM oven/bun:1.4.2 AS dependencies
WORKDIR /dependencies
COPY package.json bun.lock bunfig.toml ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/proxy/package.json ./packages/proxy/package.json
COPY apps/cli/package.json ./apps/cli/package.json
RUN bun install --production --frozen-lockfile

FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/cli/src/ ./apps/cli/src/
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/shared/src/ ./packages/shared/src/
COPY packages/core/src/ ./packages/core/src/
COPY packages/proxy/package.json ./packages/proxy/package.json
COPY packages/proxy/src/ ./packages/proxy/src/
COPY --from=dependencies /dependencies/node_modules/ ./node_modules/
# Host files may be owner-only; Compose runs with the host user's numeric UID.
RUN chmod -R a+rX /app
USER bun
EXPOSE 1456
ENTRYPOINT ["bun", "apps/cli/src/index.ts"]
CMD ["serve"]
