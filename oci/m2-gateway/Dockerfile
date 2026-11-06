# m2-gateway image — the Z4 compose slot's 8080 listener over src/memgate.
# Separate artifact from the exedev boot image (not in the walked pin ritual):
# the compose ref is seeded-once (QDS_FACTORY_OWNER + M2_GATEWAY_TAG in the
# compose project .env, F-006), so tags are chosen at publish, never floating.
# Ships `nc` for the compose healthcheck's TCP probe (slot contract).
FROM oven/bun:1.4-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*

# The server imports only repo-relative TS + node builtins; a whole-src COPY
# keeps the import graph intact without a walked-inputs ritual (this image is
# seeded-once, not the exedev pin).
WORKDIR /opt/qds-factory
COPY --chown=bun:bun src/ src/

USER bun
EXPOSE 8080
CMD ["bun", "src/memgate/server.ts"]
