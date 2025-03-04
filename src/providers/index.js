/**
 * DNS Providers index
 * Exports all provider-related components
 */
const DNSProvider = require('./base');
const DNSProviderFactory = require('./factory');
const CloudflareProvider = require('./cloudflare');
// const Route53Provider = require('./route53');

// Provider types enum for easier reference
const ProviderTypes = {
  CLOUDFLARE: 'cloudflare',
  ROUTE53: 'route53'
};

// Export all providers and utilities
module.exports = {
  // Base classes
  DNSProvider,
  DNSProviderFactory,
  
  // Provider implementations
  CloudflareProvider,
  // Route53Provider,
  
  // Constants
  ProviderTypes
};