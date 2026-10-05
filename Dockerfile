FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production OPENDOTS_CONTAINER=true HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/data/opendots.sqlite
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY .env.schema ./
COPY scripts/varlock.mjs ./scripts/varlock.mjs
USER node
EXPOSE 4310
CMD ["npm", "start"]

FROM node:24-bookworm-slim AS browser
ENV NODE_ENV=production OPENDOTS_CONTAINER=true BROWSER_HOST=0.0.0.0 BROWSER_PORT=4311 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist/server ./dist/server
COPY .env.schema ./
COPY scripts/varlock.mjs ./scripts/varlock.mjs
USER node
EXPOSE 4311
CMD ["npm", "run", "browser:start"]
