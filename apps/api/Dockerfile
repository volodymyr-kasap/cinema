FROM node:24-alpine AS build
WORKDIR /repo

# Manifests first: npm ci is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run contracts:build && npm run build -w @cinema/api

FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# --ignore-scripts: the root "prepare" script is husky, a devDependency that
# --omit=dev leaves out, so lifecycle scripts would fail with exit 127 here.
# Every runtime dependency of @cinema/api is pure JS with no build step.
RUN npm ci --omit=dev --workspace @cinema/api --include-workspace-root --ignore-scripts \
  && npm cache clean --force

COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/drizzle apps/api/drizzle

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
