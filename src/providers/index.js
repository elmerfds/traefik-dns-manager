/**
 * DNS Providers index
 * Exports all provider-related components
 */
const DNSProvider = require('./base');
const DNSProviderFactory = require('./factory');
const CloudflareProvider = require('./cloudflare');

// Export as both named exports and default object
module.exports = {
  DNSProvider,
  DNSProviderFactory,
  CloudflareProvider
};