# Static frontend for Disco. The "generator" service type means Disco builds
# this image, then serves the files at publicPath — no long-running process.
FROM alpine:3
WORKDIR /site
COPY index.html style.css script.js ./public/
