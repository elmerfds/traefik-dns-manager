/**
 * Configuration management for Traefik DNS Manager
 */
const axios = require('axios');
const logger = require('../utils/logger');
const EnvironmentLoader = require('./EnvironmentLoader');

// Semaphore for IP update process
let ipUpdateInProgress = false;

class ConfigManager {
  constructor() {
    // Initialize IP cache first to avoid reference errors
    this.ipCache = {
      ipv4: process.env.PUBLIC_IP || null,
      ipv6: process.env.PUBLIC_IPV6 || null,
      lastCheck: 0
    };
    
    // DNS Provider configuration
    this.dnsProvider = EnvironmentLoader.getString('DNS_PROVIDER', 'cloudflare');
    
    // Provider-specific settings
    // Cloudflare settings
    this.cloudflareToken = EnvironmentLoader.getString('CLOUDFLARE_TOKEN');
    this.cloudflareZone = EnvironmentLoader.getString('CLOUDFLARE_ZONE');
    
    // Route53 settings (for future implementation)
    this.route53AccessKey = EnvironmentLoader.getString('ROUTE53_ACCESS_KEY');
    this.route53SecretKey = EnvironmentLoader.getString('ROUTE53_SECRET_KEY');
    this.route53Zone = EnvironmentLoader.getString('ROUTE53_ZONE');
    
    // Digital Ocean settings (for future implementation)
    this.digitalOceanToken = EnvironmentLoader.getString('DO_TOKEN');
    this.digitalOceanDomain = EnvironmentLoader.getString('DO_DOMAIN');
    
    // Validate required settings based on provider
    this.validateProviderConfig();
    
    // Traefik API settings
    this.traefikApiUrl = EnvironmentLoader.getString('TRAEFIK_API_URL', 'http://traefik:8080/api');
    this.traefikApiUsername = EnvironmentLoader.getString('TRAEFIK_API_USERNAME');
    this.traefikApiPassword = EnvironmentLoader.getString('TRAEFIK_API_PASSWORD');
    
    // Label prefixes
    this.genericLabelPrefix = EnvironmentLoader.getString('DNS_LABEL_PREFIX', 'dns.');
    this.dnsLabelPrefix = `${this.genericLabelPrefix}${this.dnsProvider}.`;
    this.traefikLabelPrefix = EnvironmentLoader.getString('TRAEFIK_LABEL_PREFIX', 'traefik.');
    
    // Global DNS defaults
    this.defaultRecordType = EnvironmentLoader.getString('DNS_DEFAULT_TYPE', 'CNAME');
    this.defaultContent = EnvironmentLoader.getString('DNS_DEFAULT_CONTENT', this.getProviderDomain());
    this.defaultProxied = EnvironmentLoader.getBool('DNS_DEFAULT_PROXIED', true);
    this.defaultTTL = EnvironmentLoader.getInt('DNS_DEFAULT_TTL', 1);
    this.defaultManage = EnvironmentLoader.getBool('DNS_DEFAULT_MANAGE', true);
    
    // Record type specific defaults - we'll set A content after IP discovery
    this.recordDefaults = {
      A: {
        content: '',  // Will be set after IP discovery
        proxied: process.env.DNS_DEFAULT_A_PROXIED !== undefined ? 
                 process.env.DNS_DEFAULT_A_PROXIED !== 'false' : 
                 this.defaultProxied,
        ttl: EnvironmentLoader.getInt('DNS_DEFAULT_A_TTL', this.defaultTTL)
      },
      AAAA: {
        content: '',  // Will be set after IP discovery
        proxied: process.env.DNS_DEFAULT_AAAA_PROXIED !== undefined ? 
                 process.env.DNS_DEFAULT_AAAA_PROXIED !== 'false' : 
                 this.defaultProxied,
        ttl: EnvironmentLoader.getInt('DNS_DEFAULT_AAAA_TTL', this.defaultTTL)
      },
      CNAME: {
        content: EnvironmentLoader.getString('DNS_DEFAULT_CNAME_CONTENT', this.defaultContent || ''),
        proxied: process.env.DNS_DEFAULT_CNAME_PROXIED !== undefined ? 
                 process.env.DNS_DEFAULT_CNAME_PROXIED !== 'false' : 
                 this.defaultProxied,
        ttl: EnvironmentLoader.getInt('DNS_DEFAULT_CNAME_TTL', this.defaultTTL)
      },
      MX: {
        content: EnvironmentLoader.getString('DNS_DEFAULT_MX_CONTENT', ''),
        priority: EnvironmentLoader.getInt('DNS_DEFAULT_MX_PRIORITY', 10),
        ttl: EnvironmentLoader.getInt('DNS_DEFAULT_MX_TTL', this.defaultTTL)
      },
      TXT: {
        content: EnvironmentLoader.getString('DNS_DEFAULT_TXT_CONTENT', ''),
        ttl: EnvironmentLoader.getInt('DNS_DEFAULT_TXT_TTL', this.defaultTTL)
      },
      SRV: {
        content: EnvironmentLoader.getString('DNS_DEFAULT_SRV_CONTENT', ''),
        priority: EnvironmentLoader.getInt('DNS_DEFAULT_SRV_PRIORITY', 1),
        weight: EnvironmentLoader.getInt('DNS_DEFAULT_SRV_WEIGHT', 1),
        port: EnvironmentLoader.getInt('DNS_DEFAULT_SRV_PORT', 80),
        ttl: EnvironmentLoader.getInt('DNS_DEFAULT_SRV_TTL', this.defaultTTL)
      },
      CAA: {
        content: EnvironmentLoader.getString('DNS_DEFAULT_CAA_CONTENT', ''),
        flags: EnvironmentLoader.getInt('DNS_DEFAULT_CAA_FLAGS', 0),
        tag: EnvironmentLoader.getString('DNS_DEFAULT_CAA_TAG', 'issue'),
        ttl: EnvironmentLoader.getInt('DNS_DEFAULT_CAA_TTL', this.defaultTTL)
      }
    };
    
    // Application behavior
    this.dockerSocket = EnvironmentLoader.getString('DOCKER_SOCKET', '/var/run/docker.sock');
    this.pollInterval = EnvironmentLoader.getInt('POLL_INTERVAL', 60000);
    this.watchDockerEvents = EnvironmentLoader.getBool('WATCH_DOCKER_EVENTS', true);
    this.cleanupOrphaned = EnvironmentLoader.getBool('CLEANUP_ORPHANED', false);
    
    // Cache refresh interval in milliseconds (default: 1 hour)
    this.cacheRefreshInterval = EnvironmentLoader.getInt('DNS_CACHE_REFRESH_INTERVAL', 3600000);
    
    // IP refresh interval in milliseconds (default: 1 hour)
    this.ipRefreshInterval = EnvironmentLoader.getInt('IP_REFRESH_INTERVAL', 3600000);
    
    // Schedule immediate IP update and then periodic refresh
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
   * Validate that required config is present for the selected provider
   */
  validateProviderConfig() {
    switch (this.dnsProvider.toLowerCase()) {
      case 'cloudflare':
        if (!this.cloudflareToken) {
          throw new Error('CLOUDFLARE_TOKEN environment variable is required for Cloudflare provider');
        }
        if (!this.cloudflareZone) {
          throw new Error('CLOUDFLARE_ZONE environment variable is required for Cloudflare provider');
        }
        break;
        
      case 'route53':
        if (!this.route53AccessKey) {
          throw new Error('ROUTE53_ACCESS_KEY environment variable is required for Route53 provider');
        }
        if (!this.route53SecretKey) {
          throw new Error('ROUTE53_SECRET_KEY environment variable is required for Route53 provider');
        }
        if (!this.route53Zone) {
          throw new Error('ROUTE53_ZONE environment variable is required for Route53 provider');
        }
        break;
        
      case 'digitalocean':
        if (!this.digitalOceanToken) {
          throw new Error('DO_TOKEN environment variable is required for DigitalOcean provider');
        }
        if (!this.digitalOceanDomain) {
          throw new Error('DO_DOMAIN environment variable is required for DigitalOcean provider');
        }
        break;
        
      default:
        throw new Error(`Unsupported DNS provider: ${this.dnsProvider}`);
    }
  }
  
  /**
   * Get the main domain for the current provider
   */
  getProviderDomain() {
    switch (this.dnsProvider.toLowerCase()) {
      case 'cloudflare':
        return this.cloudflareZone;
      case 'route53':
        return this.route53Zone;
      case 'digitalocean':
        return this.digitalOceanDomain;
      default:
        return '';
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
   * Uses a semaphore to prevent concurrent updates
   */
  async updatePublicIPs() {
    // If an update is already in progress, wait for it to complete
    if (ipUpdateInProgress) {
      logger.debug('IP update already in progress, waiting...');
      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!ipUpdateInProgress) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });
      return this.ipCache;
    }
    
    ipUpdateInProgress = true;
    
    try {
      // Remember old IPs to detect changes
      const oldIpv4 = this.ipCache.ipv4;
      const oldIpv6 = this.ipCache.ipv6;
      
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
      
      // Only log once if IP has changed
      if (ipv4 && ipv4 !== oldIpv4) {
        // Log directly to console to ensure just one message
        console.log(`${new Date().toISOString()} [INFO] Public IPv4: ${ipv4}`);
      }
      
      if (ipv6 && ipv6 !== oldIpv6) {
        logger.debug(`Public IPv6: ${ipv6}`);
      }
      
      return this.ipCache;
    } catch (error) {
      logger.error(`Error updating public IPs: ${error.message}`);
      return this.ipCache;
    } finally {
      ipUpdateInProgress = false;
    }
  }
}

module.exports = ConfigManager;