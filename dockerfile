# ---------- Build stage ----------
    FROM node:20-alpine AS builder

    WORKDIR /app
    
    # Сначала только манифесты — чтобы слой с зависимостями кешировался
    COPY package*.json ./
    
    RUN npm install
    
    COPY . .
    
    RUN npm run build
    
    # Удаляем dev-зависимости, оставляем только production
    RUN npm prune --production
    
    # ---------- Production stage ----------
    FROM node:20-alpine AS production
    
    WORKDIR /app
    
    ENV NODE_ENV=production
    
    # Копируем только то, что нужно для запуска
    COPY --from=builder /app/node_modules ./node_modules
    COPY --from=builder /app/dist ./dist
    COPY --from=builder /app/package*.json ./
    
    # Запуск под непривилегированным пользователем (node уже есть в образе)
    USER node
    
    EXPOSE 3000
    
    CMD ["node", "dist/main.js"]