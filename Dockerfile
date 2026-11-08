FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-color-emoji && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY series.mjs match-share.mjs server.mjs index.html client.js client.css favicon.svg brand-logo.png brand-icon.png apple-touch-icon.png og-card.png bigscreen-og.png bigscreen.html bigscreen.js bigscreen.css activate.html activate.js display-client.mjs ./
COPY server ./server
COPY skills ./skills
ENV HOST=0.0.0.0 PORT=8080 APP_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]
