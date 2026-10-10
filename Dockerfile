
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=10000

EXPOSE 10000

CMD ["npm", "start"]
