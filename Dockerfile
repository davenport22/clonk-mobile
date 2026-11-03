# The relay. Not the game: the game is static files on a CDN.
#
# This image exists because a WebSocket needs a process that stays running, and
# serverless platforms hang up on idle sockets. It is deliberately tiny - no
# build step, no database, one file and one dependency.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server

ENV PORT=8787
EXPOSE 8787

# No dist/ is copied: in this topology the relay only relays. If you do want one
# box serving both, copy dist/ in as well and it will serve it.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "server/relay.mjs"]
