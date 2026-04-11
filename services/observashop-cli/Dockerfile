# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM golang:1.25-alpine AS builder

WORKDIR /src

# Cache modules separately from source
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Static, stripped, reproducible-ish build
ENV CGO_ENABLED=0 \
    GOOS=linux \
    GOFLAGS=-mod=readonly
RUN go build \
      -trimpath \
      -ldflags="-s -w" \
      -o /out/observashop-cli \
      .

# ---------- runtime ----------
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/observashop-cli /usr/local/bin/observashop-cli

USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/observashop-cli"]
