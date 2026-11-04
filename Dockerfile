# Pinned so a rebuild of the same commit produces the same runtime; bump
# deliberately. `apk upgrade` below still pulls Alpine security fixes.
ARG NODE_IMAGE=node:22.23.4-alpine3.24

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --production

FROM ${NODE_IMAGE}
# Remove everything the server never uses but an attacker inside the
# container would: package managers (npm, yarn, corepack, apk) and the
# busybox network/privilege tools (wget, nc, su). The health check uses
# node instead of wget.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
        /usr/bin/wget /usr/bin/nc /bin/su \
        /sbin/apk /etc/apk /lib/apk /usr/share/apk /var/cache/apk
WORKDIR /app
# Copied as root and left root-owned: the node user can read the code but
# never change it.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Node permission model: the server only reads its own code. Writing files,
# reading anything outside /app, child processes and worker threads are
# denied, so even code execution through a dependency can't start a shell
# or drop a file. Network access is not restricted by this flag.
CMD ["node", "--permission", "--allow-fs-read=/app", "dist/index.js", "--http"]
