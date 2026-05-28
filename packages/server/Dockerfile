FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY dist/ ./dist/

RUN npm install --omit=dev --ignore-scripts

EXPOSE 3000

ENV PORT=3000
CMD ["node", "dist/index.js"]
