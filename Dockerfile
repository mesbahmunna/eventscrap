# Official Microsoft Playwright image with browsers and dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000
ENV HEADLESS=true
ENV DATA_DIR=/app/data

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm ci --only=production

# Copy application source code
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

# Expose Railway web port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
