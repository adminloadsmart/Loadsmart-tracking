# One image for every process role — ROLE picks what runs (docs/ROADMAP.md §1).
# Migrations are a separate step:  docker run --rm <image> npm run migration:run:prod

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

USER node
EXPOSE 4100 4101 9100
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${OPS_PORT:-9100}/healthz" > /dev/null || exit 1

CMD ["node", "-r", "reflect-metadata", "dist/entrypoints/main.js"]
