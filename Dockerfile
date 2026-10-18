# Relayo Sim: API, SMTP, panel and landing page in one image.
#   docker build -t relayo-sim .
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# Server dependencies (all of them, to compile).
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Panel (Angular), built to static files.
FROM base AS panel
WORKDIR /app/panel
COPY panel/package.json panel/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY panel/ ./
RUN pnpm build

# Server, compiled; then only production dependencies are kept.
FROM deps AS server
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-slim
ENV NODE_ENV=production PORT=3000 SMTP_PORT=2525
WORKDIR /app
COPY package.json ./
COPY --from=server /app/node_modules ./node_modules
COPY --from=server /app/dist ./dist
COPY --from=panel /app/panel/dist/panel/browser ./panel/dist/panel/browser
COPY landing ./landing
USER node
EXPOSE 3000 2525
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
