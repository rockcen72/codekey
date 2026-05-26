FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY packages/shared ../shared/
COPY packages/server ./
RUN npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
