# Traefik DNS Manager

A service that automatically manages Cloudflare DNS records based on Traefik routing configuration.

## Features

- 🔄 Automatic DNS record management based on Traefik Host rules
- 👀 Real-time monitoring of Docker container events
- 🏷️ Support for multiple DNS record types (A, AAAA, CNAME, MX, TXT, SRV, CAA)
- 🌐 Automatic public IP detection for apex domains
- 🎛️ Fine-grained control with service-specific labels
- 💪 Fault-tolerant design with retry mechanisms
- 🧹 Optional cleanup of orphaned DNS records
- 📊 Optimized performance with DNS caching and batch processing
- 🖨️ Configurable logging levels for better troubleshooting

## Quick Start

### Docker Compose

```yaml
version: '3'

services:
  traefik-dns-manager:
    image: yourusername/traefik-dns-manager:latest
    container_name: traefik-dns-manager
    restart: unless-stopped
    user: "0:0"  # Required for Docker socket access
    environment:
      - CLOUDFLARE_TOKEN=your_cloudflare_api_token
      - CLOUDFLARE_ZONE=example.com
      - TRAEFIK_API_URL=http://traefik:8080/api
      - LOG_LEVEL=INFO
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - traefik-network
```

## Service Labels

The DNS Manager supports the following labels for customizing DNS record creation:

### Basic Labels

| Label | Description | Default |
|-------|-------------|---------|
| `dns.cloudflare.skip` | Skip DNS management for this service | `false` |
| `dns.cloudflare.type` | DNS record type (A, AAAA, CNAME, etc.) | `CNAME` or `A` for apex domains |
| `dns.cloudflare.content` | Record content/value | Domain for CNAME, Public IP for A |
| `dns.cloudflare.proxied` | Enable Cloudflare proxy (orange cloud) | `true` |
| `dns.cloudflare.ttl` | Record TTL in seconds | `1` (Auto) |

### Type-Specific Labels

| Label | Applicable Types | Description |
|-------|------------------|-------------|
| `dns.cloudflare.priority` | MX, SRV | Priority value |
| `dns.cloudflare.weight` | SRV | Weight value |
| `dns.cloudflare.port` | SRV | Port value |
| `dns.cloudflare.flags` | CAA | Flags value |
| `dns.cloudflare.tag` | CAA | Tag value |

## Usage Examples

### Basic Service with Default Settings

Just use standard Traefik labels, and DNS records are automatically created:

```yaml
services:
  my-app:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      - "traefik.http.routers.my-app.entrypoints=https"
```

This will create a CNAME record for `app.example.com` pointing to your domain.

### Disable Cloudflare Proxy for Media Servers

```yaml
services:
  my-service:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-service.rule=Host(`service.example.com`)"
      - "dns.cloudflare.proxied=false"  # Disable Cloudflare proxy
```

### Use A Record with Custom IP

```yaml
services:
  my-app:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      - "dns.cloudflare.type=A"
      - "dns.cloudflare.content=203.0.113.10"  # Custom IP address
```

### Skip DNS Management for a Service

```yaml
services:
  internal-app:
    image: internal-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.internal.rule=Host(`internal.example.com`)"
      - "dns.cloudflare.skip=true"  # Skip DNS management for this service
```

### Create MX Record

```yaml
services:
  mail-service:
    image: mail-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.mail.rule=Host(`example.com`)"
      - "dns.cloudflare.type=MX"
      - "dns.cloudflare.content=mail.example.com"
      - "dns.cloudflare.priority=10"
```

## Environment Variables

### Cloudflare Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `CLOUDFLARE_TOKEN` | Cloudflare API token with DNS edit permissions | - | Yes |
| `CLOUDFLARE_ZONE` | Your domain name (e.g., example.com) | - | Yes |

### Traefik API Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `TRAEFIK_API_URL` | URL to Traefik API | `http://traefik:8080/api` | No |
| `TRAEFIK_API_USERNAME` | Username for Traefik API basic auth | - | No |
| `TRAEFIK_API_PASSWORD` | Password for Traefik API basic auth | - | No |

### DNS Default Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DNS_DEFAULT_TYPE` | Default DNS record type | `CNAME` | No |
| `DNS_DEFAULT_CONTENT` | Default record content | Value of `CLOUDFLARE_ZONE` | No |
| `DNS_DEFAULT_PROXIED` | Default Cloudflare proxy status | `true` | No |
| `DNS_DEFAULT_TTL` | Default TTL in seconds | `1` (automatic) | No |

### IP Address Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PUBLIC_IP` | Manual override for public IPv4 | Auto-detected | No |
| `PUBLIC_IPV6` | Manual override for public IPv6 | Auto-detected | No |
| `IP_REFRESH_INTERVAL` | How often to refresh IP (ms) | `3600000` (1 hour) | No |

### Application Behavior
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `POLL_INTERVAL` | How often to poll Traefik API (ms) | `60000` (1 min) | No |
| `WATCH_DOCKER_EVENTS` | Whether to watch Docker events | `true` | No |
| `CLEANUP_ORPHANED` | Whether to remove orphaned DNS records | `false` | No |
| `DOCKER_SOCKET` | Path to Docker socket | `/var/run/docker.sock` | No |
| `LOG_LEVEL` | Logging verbosity (ERROR, WARN, INFO, DEBUG, TRACE) | `INFO` | No |
| `DNS_CACHE_REFRESH_INTERVAL` | How often to refresh DNS cache (ms) | `3600000` (1 hour) | No |

## Logging System

The application includes a configurable logging system to help with monitoring and troubleshooting:

### Log Levels

- `ERROR` - Only critical errors that break functionality
- `WARN` - Important warnings that don't break functionality
- `INFO` - Key operational information (default)
- `DEBUG` - Detailed information for troubleshooting
- `TRACE` - Extremely detailed information for deep troubleshooting

The default level is `INFO`, which provides a clean, readable output with important operational information. Set the `LOG_LEVEL` environment variable to change the logging verbosity.

### INFO Level Format

The INFO level uses special formatting with emojis for better readability:

```
✓ Starting Traefik DNS Manager
ℹ️ Cloudflare Zone: example.com
ℹ️ Processing 30 hostnames for DNS management
✓ Created A record for example.com
ℹ️ 29 DNS records are up to date
✅ Traefik DNS Manager running successfully
```

## Performance Optimization

The application includes built-in performance optimizations to reduce API calls and improve efficiency:

### DNS Caching

DNS records from Cloudflare are cached in memory to reduce API calls:

- All records are fetched in a single API call
- The cache is refreshed periodically (default: every hour)
- The refresh interval can be adjusted with the `DNS_CACHE_REFRESH_INTERVAL` variable

### Batch Processing

DNS record updates are processed in batches:

- All hostname configurations are collected first
- Records are compared against the cache in memory
- Only records that need changes receive API calls
- All other records use cached data

This significantly reduces API calls to Cloudflare, especially for deployments with many hostnames.

## Automatic Apex Domain Handling

The DNS Manager automatically detects apex domains (e.g., `example.com`) and uses A records with your public IP instead of CNAME records, which are not allowed at the apex domain level.

## Building from Source

```bash
# Clone the repository
git clone https://github.com/elmerfds/traefik-dns-manager.git
cd traefik-dns-manager

# Build the Docker image
docker build -t traefik-dns-manager .

# Run the container
docker run -d \
  --name traefik-dns-manager \
  --user 0:0 \
  -e CLOUDFLARE_TOKEN=your_token \
  -e CLOUDFLARE_ZONE=example.com \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  traefik-dns-manager
```

## License

MIT
