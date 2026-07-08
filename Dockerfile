FROM denoland/deno:alpine
WORKDIR /app
COPY main.ts .
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "main.ts"]
