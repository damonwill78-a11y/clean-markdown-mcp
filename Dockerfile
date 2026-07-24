# Apify's Playwright + Chromium base image. It ships the operating-system
# libraries a browser needs and runs as the non-root user "myuser", so the
# "Render JavaScript" option works reliably.
FROM apify/actor-node-playwright-chrome:20

# The image's default browser folder (/pw-browsers) is owned by root, but this
# build runs as the non-root user "myuser" — writing there fails with EACCES.
# Point Playwright at a writable folder inside the user's home instead. This also
# guarantees the downloaded Chromium matches OUR Playwright version exactly.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/myuser/pw-browsers

# Copy package files first so Docker can cache the npm install layer.
# --chown keeps everything owned by the image's non-root user.
COPY --chown=myuser package*.json ./

# Install ALL dependencies, including dev, so we can compile TypeScript.
RUN npm install --include=dev --audit=false --fund=false

# Copy the rest of the source and build it to ./dist.
COPY --chown=myuser . ./
RUN npm run build

# NOTE: no `npm prune --omit=dev` here — this image sets NODE_ENV=production, and
# pruning/omitting has repeatedly stripped runtime packages and broken the Actor
# with ERR_MODULE_NOT_FOUND. Keeping everything costs only image size, which does
# not matter for a server-side Actor. Don't "optimise" this without re-running the
# Actor afterwards to confirm it still starts.

# Playwright is deliberately NOT in package.json — it would force a ~150 MB
# browser download on everyone who installs the npm package. The Actor needs it,
# so install it here instead.
RUN npm install playwright --audit=false --fund=false \
 && npx playwright install chromium

# The Actor runs the compiled entry point.
CMD ["node", "dist/main.js"]
