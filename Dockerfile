# scope-sub in a container: Node plus the two external toolchains it shells out
# to (MKVToolNix and ffmpeg), which is the whole reason a container is worth it
# on a NAS box whose distro packages either the wrong versions or none at all.
#
#   docker build -t scope-sub .
#   docker run --rm scope-sub doctor
#   docker run --rm -v /srv/media:/media:ro -v "$PWD/out":/work scope-sub \
#       scan /media
#
# Mount the library read-only. Nothing scope-sub does needs write access to it,
# and `apply --replace-original` is impossible against a read-only mount, which
# is exactly the safety property worth keeping.

# ---- build: compile TypeScript and produce an installable tarball -----------
FROM node:22-slim AS build
WORKDIR /src
ENV CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: the only dev dependency that wants a postinstall is
# esbuild (via vitest), and nothing in this stage runs it.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json README.md CHANGELOG.md ./
COPY src ./src
RUN pnpm build && pnpm pack --pack-destination /out

# ---- runtime: the CLI, mkvmerge, mkvextract, ffmpeg ------------------------
FROM node:22-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends mkvtoolnix ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/scope-sub-*.tgz /tmp/
RUN npm install -g /tmp/scope-sub-*.tgz && rm -f /tmp/scope-sub-*.tgz

# Scratch space for extracted .sup files; the temp dir check in `doctor`
# reports whatever is mounted here.
ENV TMPDIR=/tmp
WORKDIR /work
ENTRYPOINT ["scope-sub"]
CMD ["doctor"]
