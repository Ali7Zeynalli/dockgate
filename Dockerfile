FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install native dependencies for sqlite and node-pty
# Also install docker cli and docker-compose to allow host compose management
RUN apk add --no-cache python3 make g++ gcc linux-headers docker-cli docker-cli-compose

# Copy package files
COPY package*.json ./

# Install dependencies (including optional ones)
RUN npm install

# Copy application code
COPY . .

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 7077

# Set production env
ENV NODE_ENV=production
ENV PORT=7077

# Start application
CMD ["npm", "start"]
