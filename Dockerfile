FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
# Host files may be owner-only; Compose runs with the host user's numeric UID.
RUN chmod -R a+rX /app
USER node
EXPOSE 1456
ENTRYPOINT ["node", "src/index.js"]
CMD ["serve"]
