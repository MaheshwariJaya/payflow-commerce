# ==========================================
# STAGE 1: Build & Compile TypeScript
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source and configurations
COPY src/ ./src
COPY prisma/ ./prisma
COPY public/ ./public

# Generate Prisma Client and compile TypeScript
RUN npx prisma generate
RUN npm run build

# ==========================================
# STAGE 2: Production Runtime Environment
# ==========================================
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy compiled build output & configurations from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "dist/server.js"]
