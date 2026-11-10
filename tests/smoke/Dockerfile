FROM node:22-bookworm-slim
WORKDIR /smoke
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install --with-deps --only-shell chromium
COPY *.mjs ./
