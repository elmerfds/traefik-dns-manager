FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package*.json ./

# If package-lock.json exists, use ci, otherwise use install
RUN test -f package-lock.json && npm ci --omit=dev || npm install --omit=dev

# Bundle app source
COPY src ./src

# Run as non-root user
USER node

# Start the app
CMD [ "node", "src/app.js" ]