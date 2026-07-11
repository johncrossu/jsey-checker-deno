FROM denoland/deno:alpine
WORKDIR /app
COPY deno.json .
COPY deno.lock .
COPY main.ts .
COPY fonts/ fonts/
COPY assets/ assets/
RUN deno install --allow-scripts
RUN deno cache --unstable-kv main.ts
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--unstable-kv", "main.ts"]
