/**
 * DNS Provider Factory
 * Responsible for creating the appropriate DNS provider based on configuration
 */
const path = require('path');
const fs = require('fs');
const logger = require('../logger');

class DNSProviderFactory {
  /**
   * Create an instance of the configured DNS provider
   * @param {Object} config - Configuration manager instance
   * @returns {DNSProvider} - An instance of the configured DNS provider
   */
  static createProvider(config) {
    const providerType = config.dnsProvider || 'cloudflare';
    
    try {
      logger.debug(`Creating DNS provider: ${providerType}`);
      
      // Try to load the provider module
      const ProviderClass = require(`./${providerType}`);
      
      // Create and return an instance
      return new ProviderClass(config);
    } catch (error) {
      logger.error(`Failed to create DNS provider '${providerType}': ${error.message}`);
      throw new Error(`DNS provider '${providerType}' not found or failed to initialize`);
    }
  }
  
  /**
   * Get a list of available DNS providers
   * @returns {Array<string>} - Array of available provider names
   */
  static getAvailableProviders() {
    const providersDir = path.join(__dirname);
    
    try {
      // Read the providers directory
      const files = fs.readdirSync(providersDir);
      
      // Filter for JavaScript files that aren't base.js or factory.js
      return files
        .filter(file => 
          file.endsWith('.js') && 
          file !== 'base.js' && 
          file !== 'factory.js' &&
          file !== 'index.js'
        )
        .map(file => file.replace('.js', ''));
    } catch (error) {
      logger.error(`Failed to list available providers: ${error.message}`);
      return [];
    }
  }
}

module.exports = DNSProviderFactory;