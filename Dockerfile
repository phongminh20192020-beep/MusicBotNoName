FROM node:22-alpine
# cache-bust: 2026-06-23b
WORKDIR /app

# ffmpeg is required at runtime for MV video streaming.
# python3/make/g++ are required to build native deps (e.g. opus) during npm install.
RUN apk add --no-cache ffmpeg python3 make g++

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
