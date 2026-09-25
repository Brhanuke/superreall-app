FROM node:20-slim

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Runtime data lives outside the image layers
VOLUME ["/app/data", "/app/media", "/app/uploads"]

ENV PORT=3000 \
    DATA_DIR=/app/data \
    MEDIA_DIR=/app/media \
    UPLOADS_DIR=/app/uploads

EXPOSE 3000

CMD ["node", "server.js"]
