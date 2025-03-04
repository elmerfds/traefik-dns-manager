/**
 * Traefik Monitor Service
 * Responsible for monitoring Traefik routers and updating DNS records
 */
const axios = require('axios');
const logger = require('../utils/logger');
const EventTypes = require('../events/EventTypes');
const { extractHostnamesFromRule } = require('../utils/traefik');

class TraefikMonitor {
  constructor(config, eventBus) {
    this.config = config;
    this.eventBus = eventBus;
    
    // Initialize HTTP client
    this.client = axios.create({
      baseURL: config.traefikApiUrl,
      timeout: 5000
    });
    
    // Add basic auth if configured
    if (config.traefikApiUsername && config.traefikApiPassword) {
      this.client.defaults.auth = {
        username: config.traefikApiUsername,
        password: config.traefikApiPassword
      };
    }
    
    // Track previous poll statistics to reduce logging noise
    this.previousStats = {
      hostnameCount: 0
    };
    
    // Lock to prevent parallel polling
    this.isPolling = false;
    
    // Poll timer reference
    this.pollTimer = null;
  }
  
  /**
   * Initialize the Traefik Monitor
   */
  async init() {
    try {
      logger.debug('Testing connection to Traefik API...');
      
      // Test connection
      const connected = await this.testConnection();
      
      if (!connected) {
        throw new Error('Failed to connect to Traefik API');
      }
      
      logger.success('Successfully connected to Traefik API');
      return true;
    } catch (error) {
      logger.error(`Failed to initialize Traefik Monitor: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Start the polling process
   */
  async startPolling() {
    // Perform initial poll
    await this.pollTraefikAPI();
    
    // Set up interval for regular polling
    this.pollTimer = setInterval(() => this.pollTraefikAPI(), this.config.pollInterval);
    
    logger.debug(`Traefik polling started with interval of ${this.config.pollInterval}ms`);
    return true;
  }
  
  /**
   * Stop the polling process
   */
  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.debug('Traefik polling stopped');
    }
  }
  
  /**
   * Test the connection to the Traefik API
   */
  async testConnection() {
    try {
      // Try to access the overview endpoint
      await this.client.get('/overview');
      return true;
    } catch (error) {
      logger.error(`Failed to connect to Traefik API: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Poll the Traefik API for routers
   */
  async pollTraefikAPI() {
    // Skip if already polling to prevent parallel execution
    if (this.isPolling) {
      logger.debug('Skipping poll - another poll cycle is already in progress');
      return;
    }
    
    // Set polling lock
    this.isPolling = true;
    
    try {
      // Publish poll started event
      this.eventBus.publish(EventTypes.TRAEFIK_POLL_STARTED);
      
      logger.debug('Polling Traefik API for routers...');
      
      // Get all routers from Traefik
      const routers = await this.getRouters();
      logger.debug(`Found ${Object.keys(routers).length} routers in Traefik`);
      
      // Collect hostname data
      const { hostnames, containerLabels } = this.processRouters(routers);
      
      // Only log hostname count if it changed from previous poll
      const hasChanged = this.previousStats.hostnameCount !== hostnames.length;
      
      if (hasChanged) {
        logger.info(`Processing ${hostnames.length} hostnames for DNS management`);
      } else {
        // Log at debug level instead of info when nothing has changed
        logger.debug(`Processing ${hostnames.length} hostnames for DNS management`);
      }
      
      // Update the previous count for next comparison
      this.previousStats.hostnameCount = hostnames.length;
      
      // Publish router update event
      this.eventBus.publish(EventTypes.TRAEFIK_ROUTERS_UPDATED, {
        hostnames,
        containerLabels
      });
      
      // Publish poll completed event
      this.eventBus.publish(EventTypes.TRAEFIK_POLL_COMPLETED, {
        routerCount: Object.keys(routers).length,
        hostnameCount: hostnames.length
      });
    } catch (error) {
      logger.error(`Error polling Traefik API: ${error.message}`);
      
      this.eventBus.publish(EventTypes.ERROR_OCCURRED, {
        source: 'TraefikMonitor.pollTraefikAPI',
        error: error.message
      });
    } finally {
      // Always release the polling lock
      this.isPolling = false;
    }
  }
  
  /**
   * Get all HTTP routers from Traefik
   */
  async getRouters() {
    try {
      const response = await this.client.get('/http/routers');
      return response.data;
    } catch (error) {
      // Check for specific error types for better error messages
      if (error.code === 'ECONNREFUSED') {
        logger.error(`Connection refused to Traefik API at ${this.config.traefikApiUrl}. Is Traefik running?`);
        throw new Error(`Connection refused to Traefik API at ${this.config.traefikApiUrl}. Is Traefik running?`);
      }
      
      if (error.response && error.response.status === 401) {
        logger.error('Authentication failed for Traefik API. Check your username and password.');
        throw new Error('Authentication failed for Traefik API. Check your username and password.');
      }
      
      logger.error(`Failed to get Traefik routers: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Process routers to extract hostnames and container labels
   */
  processRouters(routers) {
    const hostnames = [];
    const containerLabels = {};
    
    for (const [routerName, router] of Object.entries(routers)) {
      if (router.rule && router.rule.includes('Host')) {
        // Extract all hostnames from the rule
        const routerHostnames = extractHostnamesFromRule(router.rule);
        
        for (const hostname of routerHostnames) {
          hostnames.push(hostname);
          
          // Store router service information with hostname for later lookup
          containerLabels[hostname] = {
            [`${this.config.traefikLabelPrefix}http.routers.${routerName}.service`]: router.service
          };
        }
      }
    }
    
    return { hostnames, containerLabels };
  }
}

module.exports = TraefikMonitor;