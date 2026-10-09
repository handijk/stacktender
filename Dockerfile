FROM node:22-alpine

# git for the repository, the docker CLI with compose for the deploy and the runners
RUN apk add --no-cache git docker-cli docker-cli-compose

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY index.js ./
COPY lib/ ./lib/

# Run it as the user that owns the stack directory, with the docker socket's group:
#   user: "1000:1000"
#   group_add: ["<gid of /var/run/docker.sock>"]
# and mount the stack directory at its own host path, so compose resolves the bind mounts:
#   volumes: ["/var/run/docker.sock:/var/run/docker.sock", "/home/me/stack:/home/me/stack"]
#   working_dir: /home/me/stack
ENV NODE_ENV=production \
    HOME=/tmp \
    STACKTENDER_PORT=8800 \
    STACKTENDER_HOST=0.0.0.0

EXPOSE 8800
ENTRYPOINT ["node", "/app/index.js"]
