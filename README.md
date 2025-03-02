README.md
# Traefik DNS Manager

A service that automatically manages Cloudflare DNS records based on Traefik routing configuration.

## Features

- 🔄 Automatic DNS record management based on Traefik Host rules
- 👀 Real-time monitoring of Docker container events
- 🏷️ Support for multiple DNS record types (A, AAAA, CNAME, MX, TXT, SRV, CAA)
- 💪 Fault-tolerant design with retry mechanisms
- 🧹 Optional cleanup of orphaned DNS records

## Quick Start

### Docker Compose

```yaml
version: '3'

services:
  traefik-dns-manager:
    image: yourusername/traefik-dns-manager:latest
    container_name: traefik-dns-manager
    restart: unless-stopped
    environment:
      - CLOUDFLARE_TOKEN=your_cloudflare_api_token
      - CLOUDFLARE_ZONE=example.com
      - TRAEFIK_API_URL=http://traefik:8080/api
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - traefik-network
```

### Environment Variables

#### Required Settings
- `CLOUDFLARE_TOKEN`: Your Cloudflare API token with DNS edit permissions
- `CLOUDFLARE_ZONE`: Your domain name (e.g., example.com)

#### Traefik API Settings
- `TRAEFIK_API_URL`: URL to Traefik API (default: `http://traefik:8080/api`)
- `TRAEFIK_API_USERNAME`: Username for Traefik API basic auth (optional)
- `TRAEFIK_API_PASSWORD`: Password for Traefik API basic auth (optional)

#### DNS Default Settings
- `DNS_DEFAULT_TYPE`: Default DNS record type (default: `CNAME`)
- `DNS_DEFAULT_CONTENT`: Default record content (default: value of CLOUDFLARE_ZONE)
- `DNS_DEFAULT_PROXIED`: Default proxy status (default: `true`)
- `DNS_DEFAULT_TTL`: Default TTL in seconds (default: `1` for automatic)

#### Type-Specific Default Settings
- `DNS_DEFAULT_[TYPE]_CONTENT`: Default content for specific record type
- `DNS_DEFAULT_[TYPE]_PROXIED`: Default proxy status for specific record type
- `DNS_DEFAULT_[TYPE]_TTL`: Default TTL for specific record type
- `DNS_DEFAULT_MX_PRIORITY`: Default priority for MX records (default: `10`)
- `DNS_DEFAULT_SRV_PORT`: Default port for SRV records

#### Application Behavior
- `POLL_INTERVAL`: Interval in ms to poll Traefik API (default: `60000`)
- `WATCH_DOCKER_EVENTS`: Whether to watch Docker events (default: `true`)
- `CLEANUP_ORPHANED`: Whether to remove orphaned DNS records (default: `false`)

## Usage With Traefik

Just add the standard Traefik labels to your services:

```yaml
services:
  my-app:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      - "traefik.http.routers.my-app.entrypoints=https"
```

The DNS Manager will automatically create a DNS record for `app.example.com`.

## Advanced Configuration

You can override DNS settings per service using labels:

```yaml
services:
  my-app:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      # Override DNS settings
      - "dns.cloudflare.type=A"
      - "dns.cloudflare.content=203.0.113.10"
      - "dns.cloudflare.proxied=false"
      - "dns.cloudflare.ttl=3600"
```

## Building from Source

```bash
# Clone the repository
git clone https://github.com/yourusername/traefik-dns-manager.git
cd traefik-dns-manager

# Build the Docker image
docker build -t traefik-dns-manager .

# Run the container
docker run -d \
  --name traefik-dns-manager \
  -e CLOUDFLARE_TOKEN=your_token \
  -e CLOUDFLARE_ZONE=example.com \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  traefik-dns-manager
```

## License

MIT
