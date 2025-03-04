/**
 * Cloudflare record format converter utilities
 * Handles conversion between internal format and Cloudflare API format
 */
const logger = require('../../logger');

/**
 * Convert standard record format to Cloudflare API format
 * @param {Object} record - Record in standard format
 * @returns {Object} - Record in Cloudflare format
 */
function convertToCloudflareFormat(record) {
  logger.trace(`cloudflare.converter: Converting record to Cloudflare format: ${JSON.stringify(record)}`);
  
  // Most fields map directly
  const cloudflareRecord = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl
  };
  
  // Copy proxied flag for supported record types
  if (['A', 'AAAA', 'CNAME'].includes(record.type)) {
    cloudflareRecord.proxied = record.proxied;
  }
  
  // Copy comment if present
  if (record.comment) {
    cloudflareRecord.comment = record.comment;
  }
  
  // Type-specific fields
  switch (record.type) {
    case 'MX':
      cloudflareRecord.priority = record.priority || 10;
      break;
      
    case 'SRV':
      cloudflareRecord.priority = record.priority || 1;
      cloudflareRecord.data = {
        name: record.name,
        weight: record.weight || 1,
        port: record.port || 80,
        target: record.content
      };
      break;
      
    case 'CAA':
      cloudflareRecord.data = {
        flags: record.flags || 0,
        tag: record.tag || 'issue',
        value: record.content
      };
      break;
      
    case 'TXT':
      // Ensure TXT records are properly formatted (may need special handling)
      break;
  }
  
  logger.trace(`cloudflare.converter: Converted to Cloudflare format: ${JSON.stringify(cloudflareRecord)}`);
  return cloudflareRecord;
}

/**
 * Convert Cloudflare record format to standard format
 * @param {Object} cloudflareRecord - Record in Cloudflare format
 * @returns {Object} - Record in standard format
 */
function convertRecord(cloudflareRecord) {
  logger.trace(`cloudflare.converter: Converting from Cloudflare format: ${JSON.stringify(cloudflareRecord)}`);
  
  // Basic record format
  const standardRecord = {
    id: cloudflareRecord.id,
    type: cloudflareRecord.type,
    name: cloudflareRecord.name,
    content: cloudflareRecord.content,
    ttl: cloudflareRecord.ttl
  };
  
  // Copy proxied status for supported record types
  if (['A', 'AAAA', 'CNAME'].includes(cloudflareRecord.type)) {
    standardRecord.proxied = cloudflareRecord.proxied;
  }
  
  // Copy comment if present
  if (cloudflareRecord.comment) {
    standardRecord.comment = cloudflareRecord.comment;
  }
  
  // Type-specific fields
  switch (cloudflareRecord.type) {
    case 'MX':
      standardRecord.priority = cloudflareRecord.priority;
      break;
      
    case 'SRV':
      if (cloudflareRecord.data) {
        standardRecord.priority = cloudflareRecord.data.priority;
        standardRecord.weight = cloudflareRecord.data.weight;
        standardRecord.port = cloudflareRecord.data.port;
        standardRecord.content = cloudflareRecord.data.target;
      }
      break;
      
    case 'CAA':
      if (cloudflareRecord.data) {
        standardRecord.flags = cloudflareRecord.data.flags;
        standardRecord.tag = cloudflareRecord.data.tag;
        standardRecord.content = cloudflareRecord.data.value;
      }
      break;
  }
  
  logger.trace(`cloudflare.converter: Converted to standard format: ${JSON.stringify(standardRecord)}`);
  return standardRecord;
}

module.exports = {
  convertToCloudflareFormat,
  convertRecord
};