FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

# Run as the unprivileged "node" user that ships with the image.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
