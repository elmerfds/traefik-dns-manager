/**
 * Traefik API client for retrieving router configurations
 */
const axios = require('axios');

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
      return response.data;
    } catch (error) {
      console.error('Failed to get Traefik routers:', error.message);
      
      // Check for specific error types for better error messages
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Connection refused to Traefik API at ${this.apiUrl}. Is Traefik running?`);
      }
      
      if (error.response && error.response.status === 401) {
        throw new Error('Authentication failed for Traefik API. Check your username and password.');
      }
      
      throw error;
    }
  }
  
  /**
   * Get all HTTP services from Traefik
   */
  async getServices() {
    try {
      const response = await this.client.get('/http/services');
      return response.data;
    } catch (error) {
      console.error('Failed to get Traefik services:', error.message);
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
      return true;
    } catch (error) {
      console.error('Failed to connect to Traefik API:', error.message);
      return false;
    }
  }
}

module.exports = TraefikAPI;