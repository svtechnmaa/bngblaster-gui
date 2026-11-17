# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build

# Base path the app is served under. This image serves the SPA at the domain
# root (see nginx.conf), so default to "/". Override with
# --build-arg VITE_BASE_PATH=/subpath/ when deploying under a subpath.
ARG VITE_BASE_PATH=/

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package*.json ./
RUN npm install
COPY --chown=node:node . .
RUN VITE_BASE_PATH=$VITE_BASE_PATH npm run build

# ── Runtime: Nginx ───────────────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Nginx needs writable cache and PID paths when its master runs as non-root.
RUN sed -i -e '/^[[:space:]]*user[[:space:]]/d' \
        -e 's@/var/run/nginx.pid@/tmp/nginx.pid@g' \
        -e 's@/run/nginx.pid@/tmp/nginx.pid@g' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /var/cache/nginx

USER nginx
RUN nginx -t

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
