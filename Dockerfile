# Cable Atlas — static build served by nginx.
# The app renders on the visitor's GPU (WebGL); the container only serves files.
#
#   docker build -t cable-atlas .
#   docker run -p 8080:80 cable-atlas

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK CMD wget -qO- http://localhost/ >/dev/null || exit 1
