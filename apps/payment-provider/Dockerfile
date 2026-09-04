FROM node:24-alpine AS build
WORKDIR /repo

# Manifests first: npm ci is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/payment-provider/package.json apps/payment-provider/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/payment-provider apps/payment-provider
RUN npm run contracts:build && npm run build -w @cinema/payment-provider

FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/payment-provider/package.json apps/payment-provider/
# --ignore-scripts for the same reason the API image does it: the root
# "prepare" script is husky, a devDependency --omit=dev leaves out.
RUN npm ci --omit=dev --workspace @cinema/payment-provider --include-workspace-root --ignore-scripts \
  && npm cache clean --force

COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build /repo/apps/payment-provider/dist apps/payment-provider/dist

USER node
EXPOSE 4000
CMD ["node", "apps/payment-provider/dist/main.js"]
