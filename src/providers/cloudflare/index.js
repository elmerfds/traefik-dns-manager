/**
 * Cloudflare Provider module
 * Exports the Cloudflare DNS provider implementation
 */
const CloudflareProvider = require('./provider');
const { convertRecord, convertToCloudflareFormat } = require('./converter');
const { validateRecord } = require('./validator');

// Export the provider class as default
module.exports = CloudflareProvider;

// Also export utility functions
module.exports.convertRecord = convertRecord;
module.exports.convertToCloudflareFormat = convertToCloudflareFormat;
module.exports.validateRecord = validateRecord;