# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build

# Base path the app is served under. This image serves the SPA at the domain
# root (see nginx.conf), so default to "/". Override with
# --build-arg VITE_BASE_PATH=/subpath/ when deploying under a subpath.
ARG VITE_BASE_PATH=/

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN VITE_BASE_PATH=$VITE_BASE_PATH npm run build

# ── Runtime: Nginx ───────────────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
