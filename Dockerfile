FROM denoland/deno:debian-2.6.8

WORKDIR /app

LABEL org.opencontainers.image.title="Mnemosyne Gateway" \
      org.opencontainers.image.description="Hosted and self-hosted MCP memory substrate for durable recall, replay, reflection, and benchmark-backed continuity." \
      org.opencontainers.image.url="https://multinex.ai/mnemosyne" \
      org.opencontainers.image.documentation="https://multinex.ai/benchmarks/mnemosyne" \
      org.opencontainers.image.source="https://github.com/multinex-ai/multinex/tree/staging/products/munx-memorystack/gateway-deno" \
      io.modelcontextprotocol.server.name="com.multinex/mnemosyne"

COPY . .

# Remove incompatible lockfile and regenerate
RUN rm -f deno.lock && deno cache mod.ts

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "mod.ts"]
