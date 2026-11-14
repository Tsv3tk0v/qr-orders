# Един образ: сървър + уеб екрани. Строи се от инсталатора; не е нужно да се пипа.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
COPY db db
RUN pnpm --filter @qr/web build

FROM node:22-bookworm-slim
ENV NODE_ENV=production TZ=Europe/Sofia
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /import && chown node:node /import
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["apps/api/node_modules/.bin/tsx", "apps/api/src/server.ts"]
