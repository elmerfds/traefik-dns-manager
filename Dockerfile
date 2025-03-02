FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY src ./src

# Run as non-root user
USER node

# Start the app
CMD [ "node", "src/app.js" ]