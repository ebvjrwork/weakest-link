# Multi-stage build: a small static Go binary, no CGO (modernc.org/sqlite is
# pure Go), served from a minimal distroless runtime image.

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/server ./server
COPY web/ ./web/
VOLUME ["/app/data"]
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["./server"]
