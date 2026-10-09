FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.5.0@sha256:eb942ccd44cc259d68ece8fbdf59795d4451c893592d5ea1d8e0fd5cb963d547 AS daemon
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
COPY --from=daemon /usr/local/bin/computerd /usr/local/bin/computerd
ENV PORT=8080 MOUNT_POINT=/workspace FUSE_MOUNT=auto
EXPOSE 8080
ENTRYPOINT ["timeout", "--signal=KILL", "35s", "/usr/local/bin/computerd"]
