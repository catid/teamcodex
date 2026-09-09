FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
USER node
EXPOSE 1456
ENTRYPOINT ["node", "src/index.js"]
CMD ["serve"]
