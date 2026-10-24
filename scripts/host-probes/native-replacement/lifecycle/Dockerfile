# syntax=docker/dockerfile:1
# Probe image only. The outer launcher must pass NODE_IMAGE as an immutable digest.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}

ARG NODE_IMAGE
RUN case "$NODE_IMAGE" in *@sha256:*) ;; *) echo "NODE_IMAGE must be an immutable sha256 digest" >&2; exit 1 ;; esac

ARG OPENCODE_CLI_VERSION=2.1.3
ARG OPENCODE_CLI_INTEGRITY=sha512-9gS4ZV4w/DtUFwbYs9AK7P293+AoCx7ED/Sq5A8Mu1xRVYSXMRljXPdF3+Ikl60UyxjFf0JS/UkDZe4BhivKYw==
ARG OPENCODE_CLI_PLATFORM_INTEGRITY=sha512-WVO7TebdgAcPnoOQ390ny3oyqpCH5MpPU76lHXml3G/wJz6QLxjzsQW2Lrabiewg046yAeKlf+1nPPZElF1qPw==

# Registry integrity is checked against the pinned values before install. No lockfile is
# synthesized here; npm verifies the registry metadata integrity again during install.
# --ignore-scripts is intentional: package lifecycle scripts must not run in this image.
RUN set -eu; \
    test "$(npm view "@opencode/cli@${OPENCODE_CLI_VERSION}" dist.integrity)" = "${OPENCODE_CLI_INTEGRITY}"; \
    test "$(npm view "@opencode/cli-linux-x64@${OPENCODE_CLI_VERSION}" dist.integrity)" = "${OPENCODE_CLI_PLATFORM_INTEGRITY}"; \
    npm install --global --ignore-scripts --no-audit --no-fund \
      "@opencode/cli@${OPENCODE_CLI_VERSION}" \
      "@opencode/cli-linux-x64@${OPENCODE_CLI_VERSION}"; \
    npm cache clean --force

# Without its postinstall the @opencode/cli global bin shim is a 229-byte generated
# placeholder that exits 1. Repoint the image-owned entrypoint at the explicitly installed,
# registry-integrity-checked linux-x64 platform binary instead of executing package scripts.
# The path is fixed for the known linux/amd64 target; there is no candidate search or mutable
# fallback. The runtime rootfs is mounted read-only, so the symlink stays immutable.
RUN set -eu; \
    bin=/usr/local/lib/node_modules/@opencode/cli-linux-x64/bin/opencode; \
    test -f "$bin"; \
    test ! -L "$bin"; \
    test -x "$bin"; \
    test -s "$bin"; \
    test "$(od -An -tx1 -N4 "$bin" | tr -d ' \n')" = "7f454c46"; \
    ln -sfn "$bin" /usr/local/bin/opencode; \
    test -L /usr/local/bin/opencode; \
    test "$(readlink /usr/local/bin/opencode)" = "$bin"; \
    /usr/local/bin/opencode --version >/dev/null 2>&1; \
    test "$OPENCODE_CLI_VERSION" = "2.1.3"

RUN mkdir -p /opt/sessionport/lifecycle
COPY --chown=1000:1000 --chmod=0444 entry.bundle.mjs /opt/sessionport/lifecycle/entry.bundle.mjs
RUN test -s /opt/sessionport/lifecycle/entry.bundle.mjs

USER 1000:1000
WORKDIR /opt/sessionport/lifecycle
CMD ["node", "/opt/sessionport/lifecycle/entry.bundle.mjs"]
