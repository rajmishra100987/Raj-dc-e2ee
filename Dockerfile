FROM mcr.microsoft.com/playwright:v1.44.0-noble

# App directory create karein
WORKDIR /app

# Package files copy karein
COPY package*.json ./

# Dependencies install karein
RUN npm install

# Baaki source code copy karein
COPY . .

# Server port expose karein
EXPOSE 8080

# Application start command
CMD ["node", "server.js"]
