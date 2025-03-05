/**
 * DigitalOcean record format converter utilities
 * Handles conversion between internal format and DigitalOcean API format
 */
const logger = require('../../utils/logger');

/**
 * Convert standard record format to DigitalOcean API format
 * @param {Object} record - Record in standard format
 * @returns {Object} - Record in DigitalOcean format
 */
function convertToDigitalOceanFormat(record) {
  logger.trace(`digitalocean.converter: Converting record to DigitalOcean format: ${JSON.stringify(record)}`);
  
  // Base record format for DigitalOcean
  const doRecord = {
    type: record.type,
    name: record.name,
    ttl: record.ttl
  };
  
  // DigitalOcean uses "data" instead of "content" for most record types
  if (record.content) {
    doRecord.data = record.content;
  }
  
  // Type-specific fields
  switch (record.type) {
    case 'MX':
      doRecord.priority = record.priority || 10;
      break;
      
    case 'SRV':
      // DigitalOcean SRV format requires separate fields
      doRecord.priority = record.priority || 1;
      doRecord.weight = record.weight || 1;
      doRecord.port = record.port || 80;
      
      // For SRV, the content becomes the target field in data
      doRecord.data = record.content;
      break;
      
    case 'CAA':
      // DigitalOcean CAA format requires flags and tag
      doRecord.flags = record.flags || 0;
      doRecord.tag = record.tag || 'issue';
      break;
      
    case 'TXT':
      // Ensure TXT records are properly formatted
      // DigitalOcean may require specific formatting for TXT records
      break;
  }
  
  logger.trace(`digitalocean.converter: Converted to DigitalOcean format: ${JSON.stringify(doRecord)}`);
  return doRecord;
}

/**
 * Convert DigitalOcean record format to standard format
 * @param {Object} doRecord - Record in DigitalOcean format
 * @param {string} domain - The domain name
 * @returns {Object} - Record in standard format
 */
function convertRecord(doRecord, domain) {
  logger.trace(`digitalocean.converter: Converting from DigitalOcean format: ${JSON.stringify(doRecord)}`);
  
  // Basic record format
  const standardRecord = {
    id: doRecord.id,
    type: doRecord.type,
    ttl: doRecord.ttl
  };
  
  // Handle name - DigitalOcean uses @ for apex domains
  if (doRecord.name === '@') {
    standardRecord.name = domain;
  } else {
    standardRecord.name = `${doRecord.name}.${domain}`;
  }
  
  // DigitalOcean uses "data" instead of "content" for most record types
  if (doRecord.data) {
    standardRecord.content = doRecord.data;
  }
  
  // Type-specific fields
  switch (doRecord.type) {
    case 'MX':
      standardRecord.priority = doRecord.priority;
      break;
      
    case 'SRV':
      standardRecord.priority = doRecord.priority;
      standardRecord.weight = doRecord.weight;
      standardRecord.port = doRecord.port;
      // For SRV, the data field becomes the content
      standardRecord.content = doRecord.data;
      break;
      
    case 'CAA':
      standardRecord.flags = doRecord.flags;
      standardRecord.tag = doRecord.tag;
      break;
  }
  
  logger.trace(`digitalocean.converter: Converted to standard format: ${JSON.stringify(standardRecord)}`);
  return standardRecord;
}

module.exports = {
  convertToDigitalOceanFormat,
  convertRecord
};