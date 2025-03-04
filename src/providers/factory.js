/**
 * DNS Provider Factory
 * Responsible for creating the appropriate DNS provider based on configuration
 */
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

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
      let ProviderClass;
      
      try {
        // First try to load from provider folder (new structure)
        const providerDirPath = path.join(__dirname, providerType);
        
        if (fs.existsSync(providerDirPath) && fs.statSync(providerDirPath).isDirectory()) {
          // Provider directory exists, load the main provider module
          ProviderClass = require(`./${providerType}`);
        } else {
          // Try to load as a single file (legacy/simple providers)
          const providerPath = path.join(__dirname, `${providerType}.js`);
          
          if (fs.existsSync(providerPath)) {
            ProviderClass = require(`./${providerType}.js`);
          } else {
            throw new Error(`Provider module not found: ${providerType}`);
          }
        }
      } catch (error) {
        throw new Error(`Failed to load provider module: ${error.message}`);
      }
      
      // Check if the provider exports a class (function constructor)
      if (typeof ProviderClass !== 'function') {
        // If it's an object with a default export (ES modules), use that
        if (ProviderClass.default && typeof ProviderClass.default === 'function') {
          ProviderClass = ProviderClass.default;
        } else {
          throw new Error(`Provider module does not export a class constructor: ${providerType}`);
        }
      }
      
      // Create and return an instance
      return new ProviderClass(config);
    } catch (error) {
      logger.error(`Failed to create DNS provider '${providerType}': ${error.message}`);
      throw new Error(`DNS provider '${providerType}' not found or failed to initialize: ${error.message}`);
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
      const items = fs.readdirSync(providersDir);
      const providers = [];
      
      // Check both directories and .js files
      for (const item of items) {
        const itemPath = path.join(providersDir, item);
        
        if (fs.statSync(itemPath).isDirectory()) {
          // Check if this directory contains a provider.js or index.js file
          if (
            fs.existsSync(path.join(itemPath, 'provider.js')) || 
            fs.existsSync(path.join(itemPath, 'index.js'))
          ) {
            providers.push(item);
          }
        } else if (
          item.endsWith('.js') && 
          item !== 'base.js' && 
          item !== 'factory.js' &&
          item !== 'index.js'
        ) {
          // It's a .js file that could be a provider
          providers.push(item.replace('.js', ''));
        }
      }
      
      return providers;
    } catch (error) {
      logger.error(`Failed to list available providers: ${error.message}`);
      return [];
    }
  }
}

module.exports = DNSProviderFactory;