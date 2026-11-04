FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY series.mjs game-share.mjs server.mjs index.html client.js client.css favicon.svg ./
COPY server ./server
COPY skills ./skills
COPY images ./images
ENV HOST=0.0.0.0 PORT=8080 APP_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
