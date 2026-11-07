# Root Cellar Labels: the app plus a small print system (CUPS) with DYMO LabelWriter drivers.
FROM node:22-bookworm-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cups cups-client cups-filters printer-driver-dymo ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js docker-entrypoint.sh ./
COPY public ./public
RUN chmod +x docker-entrypoint.sh
ENV PORT=8095 DATA_DIR=/data
EXPOSE 8095
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
