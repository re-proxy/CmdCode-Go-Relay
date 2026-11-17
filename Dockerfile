FROM node:22-alpine

WORKDIR /app

# The relay has no runtime dependencies; keep the image tiny and offline-buildable.
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8317 \
    RELAY_DATA_FILE=/data/relay.json

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8317
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||8317)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint is the server; `... keygen` prints a master key and exits.
ENTRYPOINT ["node", "src/server.mjs"]
