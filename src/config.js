/**
 * Configuration management for Traefik DNS Manager
 */
class ConfigManager {
  constructor() {
    // Required Cloudflare settings
    this.cloudflareToken = process.env.CLOUDFLARE_TOKEN;
    this.cloudflareZone = process.env.CLOUDFLARE_ZONE;
    
    if (!this.cloudflareToken) {
      throw new Error('CLOUDFLARE_TOKEN environment variable is required');
    }
    
    if (!this.cloudflareZone) {
      throw new Error('CLOUDFLARE_ZONE environment variable is required');
    }
    
    // Traefik API settings
    this.traefikApiUrl = process.env.TRAEFIK_API_URL || 'http://traefik:8080/api';
    this.traefikApiUsername = process.env.TRAEFIK_API_USERNAME;
    this.traefikApiPassword = process.env.TRAEFIK_API_PASSWORD;
    
    // Label prefixes
    this.dnsLabelPrefix = process.env.DNS_LABEL_PREFIX || 'dns.cloudflare.';
    this.traefikLabelPrefix = process.env.TRAEFIK_LABEL_PREFIX || 'traefik.';
    
    // Global DNS defaults
    this.defaultRecordType = process.env.DNS_DEFAULT_TYPE || 'CNAME';
    this.defaultContent = process.env.DNS_DEFAULT_CONTENT || this.cloudflareZone;
    this.defaultProxied = process.env.DNS_DEFAULT_PROXIED !== 'false';
    this.defaultTTL = parseInt(process.env.DNS_DEFAULT_TTL || '1', 10);
    
    // Record type specific defaults
    this.recordDefaults = {
      A: {
        content: process.env.DNS_DEFAULT_A_CONTENT || this.getPublicIPSync() || '',
        proxied: process.env.DNS_DEFAULT_A_PROXIED !== undefined ? 
                 process.env.DNS_DEFAULT_A_PROXIED !== 'false' : 
                 this.defaultProxied,
        ttl: parseInt(process.env.DNS_DEFAULT_A_TTL || this.defaultTTL, 10)
      },
      AAAA: {
        content: process.env.DNS_DEFAULT_AAAA_CONTENT || this.getPublicIPv6Sync() || '',
        proxied: process.env.DNS_DEFAULT_AAAA_PROXIED !== undefined ? 
                 process.env.DNS_DEFAULT_AAAA_PROXIED !== 'false' : 
                 this.defaultProxied,
        ttl: parseInt(process.env.DNS_DEFAULT_AAAA_TTL || this.defaultTTL, 10)
      },
      CNAME: {
        content: process.env.DNS_DEFAULT_CNAME_CONTENT || this.defaultContent || '',
        proxied: process.env.DNS_DEFAULT_CNAME_PROXIED !== undefined ? 
                 process.env.DNS_DEFAULT_CNAME_PROXIED !== 'false' : 
                 this.defaultProxied,
        ttl: parseInt(process.env.DNS_DEFAULT_CNAME_TTL || this.defaultTTL, 10)
      },
      MX: {
        content: process.env.DNS_DEFAULT_MX_CONTENT || '',
        priority: parseInt(process.env.DNS_DEFAULT_MX_PRIORITY || '10', 10),
        ttl: parseInt(process.env.DNS_DEFAULT_MX_TTL || this.defaultTTL, 10)
      },
      TXT: {
        content: process.env.DNS_DEFAULT_TXT_CONTENT || '',
        ttl: parseInt(process.env.DNS_DEFAULT_TXT_TTL || this.defaultTTL, 10)
      },
      SRV: {
        content: process.env.DNS_DEFAULT_SRV_CONTENT || '',
        priority: parseInt(process.env.DNS_DEFAULT_SRV_PRIORITY || '1', 10),
        weight: parseInt(process.env.DNS_DEFAULT_SRV_WEIGHT || '1', 10),
        port: parseInt(process.env.DNS_DEFAULT_SRV_PORT || '80', 10),
        ttl: parseInt(process.env.DNS_DEFAULT_SRV_TTL || this.defaultTTL, 10)
      },
      CAA: {
        content: process.env.DNS_DEFAULT_CAA_CONTENT || '',
        flags: parseInt(process.env.DNS_DEFAULT_CAA_FLAGS || '0', 10),
        tag: process.env.DNS_DEFAULT_CAA_TAG || 'issue',
        ttl: parseInt(process.env.DNS_DEFAULT_CAA_TTL || this.defaultTTL, 10)
      }
    };
    
    // Application behavior
    this.dockerSocket = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
    this.pollInterval = parseInt(process.env.POLL_INTERVAL || '60000', 10);
    this.watchDockerEvents = process.env.WATCH_DOCKER_EVENTS !== 'false';
    this.cleanupOrphaned = process.env.CLEANUP_ORPHANED === 'true';
    
    // IP sync cache - actual implementation would use a proper IP service
    this.ipCache = {
      ipv4: process.env.PUBLIC_IP || null,
      ipv6: process.env.PUBLIC_IPV6 || null,
      lastCheck: 0
    };
  }
  
  /**
   * Get defaults for a specific record type
   */
  getDefaultsForType(type) {
    return this.recordDefaults[type] || {
      content: this.defaultContent,
      proxied: this.defaultProxied,
      ttl: this.defaultTTL
    };
  }
  
  /**
   * Get public IPv4 address synchronously (from cache)
   */
  getPublicIPSync() {
    return this.ipCache.ipv4;
  }
  
  /**
   * Get public IPv6 address synchronously (from cache)
   */
  getPublicIPv6Sync() {
    return this.ipCache.ipv6;
  }
  
  /**
   * Update the public IP cache
   * This would typically be called periodically in a real implementation
   */
  async updatePublicIPs() {
    // Implementation would call an IP service like ipify.org
    // For this example, we just use environment variables
    this.ipCache = {
      ipv4: process.env.PUBLIC_IP || null,
      ipv6: process.env.PUBLIC_IPV6 || null,
      lastCheck: Date.now()
    };
  }
}

module.exports = ConfigManager;