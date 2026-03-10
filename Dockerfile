FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name .github \) -prune -exec rm -rf {} + \
 && find node_modules -type f \( -name "*.d.ts" -o -name "*.map" \) -delete \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV PORT=5001
EXPOSE 5001
CMD ["node","dist/main.js"]
