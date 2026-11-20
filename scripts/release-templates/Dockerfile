FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm_config_nodedir=/usr/local npm ci --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY dist ./dist
COPY migrations ./migrations
COPY version.json third-party.json LICENSE ./
USER node
EXPOSE 8787
CMD ["node", "dist/node.js"]
