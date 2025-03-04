# Stage 1: Generate package-lock.json
FROM node:23-alpine AS dependencies
WORKDIR /app
COPY package.json .
RUN npm install --package-lock-only
RUN npm install --omit=dev

# Stage 2: Build the application
FROM node:23-alpine AS build
WORKDIR /app
COPY --from=dependencies /app/package*.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY src ./src

# Stage 3: Create the production image
FROM node:23-alpine
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src

# Run as non-root user
USER node

# Start the app
CMD ["node", "src/app.js"]