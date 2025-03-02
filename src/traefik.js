/**
 * Traefik API client for retrieving router configurations
 */
const axios = require('axios');
const logger = require('./logger');

class TraefikAPI {
  constructor(config) {
    this.config = config;
    this.apiUrl = config.traefikApiUrl;
    
    // Create HTTP client
    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 5000
    });
    
    // Add basic auth if configured
    if (config.traefikApiUsername && config.traefikApiPassword) {
      this.client.defaults.auth = {
        username: config.traefikApiUsername,
        password: config.traefikApiPassword
      };
    }
  }
  
  /**
   * Get all HTTP routers from Traefik
   */
  async getRouters() {
    try {
      const response = await this.client.get('/http/routers');
      logger.debug(`Retrieved ${Object.keys(response.data).length} routers from Traefik API`);
      return response.data;
    } catch (error) {
      // Check for specific error types for better error messages
      if (error.code === 'ECONNREFUSED') {
        logger.error(`Connection refused to Traefik API at ${this.apiUrl}. Is Traefik running?`);
        throw new Error(`Connection refused to Traefik API at ${this.apiUrl}. Is Traefik running?`);
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
   * Get all HTTP services from Traefik
   */
  async getServices() {
    try {
      const response = await this.client.get('/http/services');
      logger.debug(`Retrieved ${Object.keys(response.data).length} services from Traefik API`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get Traefik services: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Test the connection to the Traefik API
   */
  async testConnection() {
    try {
      // Try to access the overview endpoint
      await this.client.get('/overview');
      logger.success('Successfully connected to Traefik API');
      return true;
    } catch (error) {
      logger.error(`Failed to connect to Traefik API: ${error.message}`);
      return false;
    }
  }
}

module.exports = TraefikAPI;