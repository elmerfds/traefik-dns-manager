/**
 * Configuration management for Traefik DNS Manager
 */
const axios = require('axios');
const logger = require('./logger');

class ConfigManager {
  constructor() {
    // Initialize IP cache first to avoid reference errors
    this.ipCache = {
      ipv4: process.env.PUBLIC_IP || null,
      ipv6: process.env.PUBLIC_IPV6 || null,
      lastCheck: 0
    };
    
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
    
    // Record type specific defaults - we'll set A content after IP discovery
    this.recordDefaults = {
      A: {
        content: '',  // Will be set after IP discovery
        proxied: process.env.DNS_DEFAULT_A_PROXIED !== undefined ? 
                 process.env.DNS_DEFAULT_A_PROXIED !== 'false' : 
                 this.defaultProxied,
        ttl: parseInt(process.env.DNS_DEFAULT_A_TTL || this.defaultTTL, 10)
      },
      AAAA: {
        content: '',  // Will be set after IP discovery
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
    
    // Schedule immediate IP update and then periodic refresh
    this.ipRefreshInterval = parseInt(process.env.IP_REFRESH_INTERVAL || '3600000', 10);  // Default: 1 hour

    // This update will happen asynchronously - the A record defaults will be updated
    this.updatePublicIPs().then(() => {
      // Update A record defaults after IP discovery
      this.recordDefaults.A.content = process.env.DNS_DEFAULT_A_CONTENT || this.ipCache.ipv4 || '';
      this.recordDefaults.AAAA.content = process.env.DNS_DEFAULT_AAAA_CONTENT || this.ipCache.ipv6 || '';
      logger.debug(`Updated A record defaults with IP: ${this.recordDefaults.A.content}`);
    });

    // Set up periodic IP refresh
    if (this.ipRefreshInterval > 0) {
      setInterval(() => this.updatePublicIPs(), this.ipRefreshInterval);
    }
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
   * If cache is empty, will return null and trigger async update
   */
  getPublicIPSync() {
    if (!this.ipCache.ipv4) {
      // If we don't have a cached IP, trigger an async update
      // This won't block the current execution, but will update for next time
      this.updatePublicIPs();
    }
    return this.ipCache?.ipv4 || null;
  }
  
  /**
   * Get public IPv6 address synchronously (from cache)
   */
  getPublicIPv6Sync() {
    if (!this.ipCache.ipv6) {
      this.updatePublicIPs();
    }
    return this.ipCache?.ipv6 || null;
  }
  
  /**
   * Get public IP address asynchronously
   * Returns a promise that resolves to the public IP
   */
  async getPublicIP() {
    // Check if cache is fresh (less than 1 hour old)
    const cacheAge = Date.now() - this.ipCache.lastCheck;
    if (this.ipCache.ipv4 && cacheAge < this.ipRefreshInterval) {
      return this.ipCache.ipv4;
    }
    
    // Cache is stale or empty, update it
    await this.updatePublicIPs();
    return this.ipCache.ipv4;
  }
  
  /**
   * Update the public IP cache by calling external IP services
   */
  async updatePublicIPs() {
    try {
      // Use environment variables if provided, otherwise fetch from IP service
      let ipv4 = process.env.PUBLIC_IP;
      let ipv6 = process.env.PUBLIC_IPV6;
      
      // If IP not set via environment, fetch from service
      if (!ipv4) {
        try {
          // First try ipify.org
          const response = await axios.get('https://api.ipify.org', { timeout: 5000 });
          ipv4 = response.data;
        } catch (error) {
          // Fallback to ifconfig.me if ipify fails
          try {
            const response = await axios.get('https://ifconfig.me/ip', { timeout: 5000 });
            ipv4 = response.data;
          } catch (fallbackError) {
            logger.error(`Failed to fetch public IPv4 address: ${fallbackError.message}`);
          }
        }
      }
      
      // Try to get IPv6 if not set in environment
      if (!ipv6) {
        try {
          const response = await axios.get('https://api6.ipify.org', { timeout: 5000 });
          ipv6 = response.data;
        } catch (error) {
          // IPv6 fetch failure is not critical, just log it
          logger.debug('Failed to fetch public IPv6 address (this is normal if you don\'t have IPv6)');
        }
      }
      
      // Update cache
      this.ipCache = {
        ipv4: ipv4,
        ipv6: ipv6,
        lastCheck: Date.now()
      };
      
      if (ipv4) {
        logger.info(`Public IPv4: ${ipv4}`);
      }
      if (ipv6) {
        logger.debug(`Public IPv6: ${ipv6}`);
      }
      
      return this.ipCache;
    } catch (error) {
      logger.error(`Error updating public IPs: ${error.message}`);
      return this.ipCache;
    }
  }
}

module.exports = ConfigManager;