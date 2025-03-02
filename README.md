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

# Environment Variables

## Cloudflare Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `CLOUDFLARE_TOKEN` | Cloudflare API token with DNS edit permissions | - | Yes |
| `CLOUDFLARE_ZONE` | Your domain name (e.g., example.com) | - | Yes |

## Traefik API Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `TRAEFIK_API_URL` | URL to Traefik API | `http://traefik:8080/api` | No |
| `TRAEFIK_API_USERNAME` | Username for Traefik API basic auth | - | No |
| `TRAEFIK_API_PASSWORD` | Password for Traefik API basic auth | - | No |

## DNS Default Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DNS_DEFAULT_TYPE` | Default DNS record type | `CNAME` | No |
| `DNS_DEFAULT_CONTENT` | Default record content | Value of `CLOUDFLARE_ZONE` | No |
| `DNS_DEFAULT_PROXIED` | Default Cloudflare proxy status | `true` | No |
| `DNS_DEFAULT_TTL` | Default TTL in seconds | `1` (automatic) | No |

## IP Address Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PUBLIC_IP` | Manual override for public IPv4 | Auto-detected | No |
| `PUBLIC_IPV6` | Manual override for public IPv6 | Auto-detected | No |
| `IP_REFRESH_INTERVAL` | How often to refresh IP (ms) | `3600000` (1 hour) | No |

## Application Behavior
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `POLL_INTERVAL` | How often to poll Traefik API (ms) | `60000` (1 min) | No |
| `WATCH_DOCKER_EVENTS` | Whether to watch Docker events | `true` | No |
| `CLEANUP_ORPHANED` | Whether to remove orphaned DNS records | `false` | No |
| `DOCKER_SOCKET` | Path to Docker socket | `/var/run/docker.sock` | No |

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
