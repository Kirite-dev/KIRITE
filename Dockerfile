FROM rust:1.84-slim-bookworm AS builder

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY Cargo.toml Cargo.lock* ./
COPY programs/kirite/Cargo.toml programs/kirite/Cargo.toml
COPY programs/kirite/Xargo.toml programs/kirite/Xargo.toml

RUN mkdir -p programs/kirite/src && \
    echo "fn main() {}" > programs/kirite/src/lib.rs && \
    cargo build --release -p kirite || true && \
    rm -rf programs/kirite/src

COPY programs programs

RUN cargo build --release -p kirite

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -r -u 1001 -m kirite

COPY --from=builder /app/target/release/libkirite.so /usr/local/lib/kirite.so

USER kirite

WORKDIR /home/kirite

CMD ["sh", "-c", "echo 'KIRITE program built at /usr/local/lib/kirite.so'"]
