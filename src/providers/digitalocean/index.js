/**
 * DigitalOcean Provider module
 * Exports the DigitalOcean DNS provider implementation
 */
const DigitalOceanProvider = require('./provider');
const { convertRecord, convertToDigitalOceanFormat } = require('./converter');
const { validateRecord } = require('./validator');

// Export the provider class as default
module.exports = DigitalOceanProvider;

// Also export utility functions
module.exports.convertRecord = convertRecord;
module.exports.convertToDigitalOceanFormat = convertToDigitalOceanFormat;
module.exports.validateRecord = validateRecord;
