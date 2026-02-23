FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/

# Diretório para dados de sessão (volume)
RUN mkdir -p /app/auth_data

EXPOSE 3001

ENV PORT=3001
ENV NODE_ENV=production

CMD ["node", "src/index.js"]
