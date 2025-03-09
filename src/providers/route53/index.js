/**
 * Route53 Provider module
 * Exports the Route53 DNS provider implementation
 */
const Route53Provider = require('./provider');
const { convertRecord, convertToRoute53Format, ensureTrailingDot } = require('./converter');
const { validateRecord } = require('./validator');

// Export the provider class as default
module.exports = Route53Provider;

// Also export utility functions
module.exports.convertRecord = convertRecord;
module.exports.convertToRoute53Format = convertToRoute53Format;
module.exports.ensureTrailingDot = ensureTrailingDot;
module.exports.validateRecord = validateRecord;