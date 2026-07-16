FROM node:22-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY index.js ./index.js

RUN mkdir -p /data
ENV NODE_ENV=production
ENV DATA_FILE=/data/sessions.json

EXPOSE 3000
CMD ["node", "index.js"]
