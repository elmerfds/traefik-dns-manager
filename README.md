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

# GitHub Workflow Setup Guide

The included GitHub workflow automates building and publishing your Docker image to both Docker Hub and GitHub Container Registry whenever you push to the main branch or create a new tag.

## Setting Up Repository Secrets

Before the workflow can run successfully, you need to set up the following secrets in your GitHub repository:

1. Navigate to your GitHub repository
2. Go to "Settings" → "Secrets and variables" → "Actions"
3. Add the following secrets:

| Secret Name | Description |
|-------------|-------------|
| `DOCKER_USERNAME` | Your Docker Hub username |
| `DOCKER_PASSWORD` | Your Docker Hub password or access token |

## Automatic Tagging

The workflow automatically creates Docker image tags based on:

- Git branches (e.g., `main`)
- Git tags (e.g., `v1.0.0`)
- Semantic versioning (e.g., `1.0.0`, `1.0`, `1`)
- Git commit SHA

## Usage

### For Development

- Pushing to `main` or `master` branch will build and publish images tagged with the branch name and commit SHA

### For Releases

- Create and push a Git tag with semantic versioning:
  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```
- This will create Docker images with tags: `1.0.0`, `1.0`, and `1`

## Example

After setting up the workflow, when you push a tag like `v1.2.3` to your repository, the following Docker images will be published:

- `yourusername/traefik-dns-manager:1.2.3`
- `yourusername/traefik-dns-manager:1.2`
- `yourusername/traefik-dns-manager:1`
- `ghcr.io/yourusername/traefik-dns-manager:1.2.3`
- `ghcr.io/yourusername/traefik-dns-manager:1.2`
- `ghcr.io/yourusername/traefik-dns-manager:1`

## License

MIT
