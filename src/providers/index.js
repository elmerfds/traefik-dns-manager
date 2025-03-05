/**
 * DNS Providers index
 * Exports all provider-related components
 */
const DNSProvider = require('./base');
const DNSProviderFactory = require('./factory');
const CloudflareProvider = require('./cloudflare');
const DigitalOceanProvider = require('./digitalocean');
// const Route53Provider = require('./route53');

// Provider types enum for easier reference
const ProviderTypes = {
  CLOUDFLARE: 'cloudflare',
  DIGITALOCEAN: 'digitalocean',
  ROUTE53: 'route53'
};

// Export all providers and utilities
module.exports = {
  // Base classes
  DNSProvider,
  DNSProviderFactory,
  
  // Provider implementations
  CloudflareProvider,
  DigitalOceanProvider,
  // Route53Provider,
  
  // Constants
  ProviderTypes
};