# syntax=docker/dockerfile:1.7
# --- Rust data plane builder ---
FROM rust:1-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
COPY rust-data-plane ./rust-data-plane
RUN --mount=type=cache,id=clueoj-storage-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=clueoj-storage-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=clueoj-storage-cargo-target,target=/build/target \
    cargo build --release --package rust-data-plane \
    && cp /build/target/release/rust-data-plane /tmp/rust-data-plane

# --- Runtime ---
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gosu \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin storage
COPY --from=builder /tmp/rust-data-plane /usr/local/bin/rust-data-plane
COPY docker/rust-entrypoint.sh /usr/local/bin/rust-entrypoint.sh
RUN chmod 0755 /usr/local/bin/rust-entrypoint.sh
ENV STORAGE_PROBLEM_ROOT=/problems
ENV RUST_LOG=info
ENV STORAGE_RUST_UID=10001
ENV STORAGE_RUST_GID=10001
ENV STORAGE_RUST_CHECK_PROBLEM_ROOT_WRITE=true
EXPOSE 8081
ENTRYPOINT ["rust-entrypoint.sh"]
CMD ["rust-data-plane"]
