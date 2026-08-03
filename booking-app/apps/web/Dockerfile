# syntax=docker/dockerfile:1
#
# The browser bundle, served by nginx.
#
# The build context is the **repository root**, matching the API image:
#
#     docker build -f booking-app/apps/web/Dockerfile -t sf-booking-web .
#
# There is no runtime configuration in this image. The application talks to `/api` on its
# own origin, so the same bundle works on any hostname and nothing has to be substituted at
# container start — the class of deploy bug where the built artefact and the environment
# disagree simply does not exist here.
#
# This image does **not** proxy `/api`. The edge proxy routes `/api` straight to the API
# container (see infrastructure/nginx/booking.conf), which keeps the API exactly one proxy
# hop from the client — the number `app.set('trust proxy', 1)` in main.ts assumes. Adding a
# second hop here would make every rate limit and every audit row record this container's
# address instead of the caller's.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ── Dependencies ─────────────────────────────────────────────────────────────
#
# Manifests and the lockfile only, so editing a component does not re-resolve the tree.
# The API image's own dependency stage lists a different set of manifests; that is not
# duplication to be factored out, it is each image installing what it actually needs.

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY booking-app/apps/web/package.json booking-app/apps/web/
COPY booking-app/packages/config/package.json booking-app/packages/config/
COPY booking-app/packages/contracts/package.json booking-app/packages/contracts/
COPY booking-app/packages/ui/package.json booking-app/packages/ui/
# Not `--prod`: Vite, the Vue plugin and Tailwind are devDependencies and are exactly what
# performs the build. `--ignore-scripts` because `contracts` builds itself from a `prepare`
# script and its source is not in this stage yet.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts

# ── Build ────────────────────────────────────────────────────────────────────

FROM deps AS build
COPY booking-app/packages/config booking-app/packages/config
COPY booking-app/packages/contracts booking-app/packages/contracts
COPY booking-app/packages/ui booking-app/packages/ui
COPY booking-app/apps/web booking-app/apps/web
# `...` means "and everything it depends on", so contracts is compiled before Vite resolves
# it. The API is not in this image and is not built here.
RUN pnpm --filter "@shape-and-flow/booking-web..." --if-present build

# Pre-compress, so `gzip_static` can serve a maximally compressed file that cost nothing at
# request time. `-9` is affordable once at build; it is not affordable per response, which
# is why runtime `gzip` is set to a middling level and this exists.
#
# A loop rather than `gzip -k`: BusyBox's gzip is not GNU gzip and the flag set differs.
# Fonts and images are already compressed and are skipped — a .gz of a .woff2 is bigger
# than the original.
RUN cd booking-app/apps/web/dist \
 && find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
      -o -name '*.json' -o -name '*.txt' -o -name '*.webmanifest' \) \
      -size +1024c -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;

# ── Serve ────────────────────────────────────────────────────────────────────

FROM nginx:1.29-alpine AS web

# The whole nginx.conf, not a conf.d snippet: the stock file sets `pid /var/run/nginx.pid`
# and a `user` directive, neither of which works for an unprivileged process.
COPY booking-app/infrastructure/nginx/spa.conf /etc/nginx/nginx.conf
COPY --from=build /repo/booking-app/apps/web/dist /usr/share/nginx/html

# Port 8080, not 80: a process that cannot bind a privileged port is a process that is
# provably not root. The edge proxy maps it, and the browser never sees this number.
EXPOSE 8080
USER nginx

# Asks for a real file through the real server rather than checking the port, so a
# configuration that starts but serves nothing is reported unhealthy.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1

CMD ["nginx", "-g", "daemon off;"]
