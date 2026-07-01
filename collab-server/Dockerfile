FROM node:22-slim
WORKDIR /code

# install only production deps (no lockfile needed)
COPY package.json /code/package.json
RUN npm install --omit=dev

COPY . /code/.

# must match the port in disco.json and the PORT env default in server.js
EXPOSE 42420
CMD ["node", "server.js"]
