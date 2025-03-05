/**
 * DigitalOcean record format converter utilities
 * Handles conversion between internal format and DigitalOcean API format
 */
const logger = require('../../utils/logger');

/**
 * Convert standard record format to DigitalOcean API format
 * @param {Object} record - Record in standard format
 * @param {string} domain - Domain name for removing from FQDN
 * @returns {Object} - Record in DigitalOcean format
 */
function convertToDigitalOceanFormat(record, domain) {
  logger.trace(`digitalocean.converter: Converting record to DigitalOcean format: ${JSON.stringify(record)}`);
  
  // Handle apex record (@ symbol)
  let name = record.name;
  if (name === domain) {
    name = '@';
  } else if (name.endsWith(`.${domain}`)) {
    // Remove domain suffix for DigitalOcean
    name = name.slice(0, -domain.length - 1);
  }
  
  // Format the data/content value appropriately, based on record type
  let data = record.content;
  
  // For CNAME records, make sure data ends with a dot
  if (record.type === 'CNAME' && data && !data.endsWith('.')) {
    data = data + '.';
    logger.debug(`Ensuring CNAME content for ${record.name} ends with a dot: ${data}`);
  }
  
  // Basic record data
  const doRecord = {
    type: record.type,
    name: name,
    data: data,
  };
  
  // Add TTL if specified
  if (record.ttl !== undefined) {
    doRecord.ttl = record.ttl;
  }
  
  // Add priority for MX records
  if (record.type === 'MX' && record.priority !== undefined) {
    doRecord.priority = record.priority;
  }
  
  // Type-specific fields
  switch (record.type) {
    case 'SRV':
      doRecord.priority = record.priority || 1;
      doRecord.weight = record.weight || 1;
      doRecord.port = record.port || 80;
      break;
      
    case 'CAA':
      doRecord.flags = record.flags || 0;
      doRecord.tag = record.tag || 'issue';
      break;
  }
  
  logger.trace(`digitalocean.converter: Converted to DigitalOcean format: ${JSON.stringify(doRecord)}`);
  return doRecord;
}

/**
 * Convert DigitalOcean record format to standard format
 * @param {Object} doRecord - Record in DigitalOcean format
 * @param {string} domain - Domain name for forming FQDN
 * @returns {Object} - Record in standard format
 */
function convertRecord(doRecord, domain) {
  logger.trace(`digitalocean.converter: Converting from DigitalOcean format: ${JSON.stringify(doRecord)}`);
  
  // Handle @ symbol for apex record
  let name = doRecord.name;
  if (name === '@') {
    name = domain;
  } else {
    // Add domain suffix for full domain name
    name = `${name}.${domain}`;
  }
  
  // Build content from data, removing trailing dot for CNAME if present
  let content = doRecord.data;
  if (doRecord.type === 'CNAME' && content && content.endsWith('.')) {
    content = content.slice(0, -1);
  }
  
  // Basic record format
  const standardRecord = {
    id: doRecord.id,
    type: doRecord.type,
    name: name,
    content: content,
  };
  
  // Add TTL if present
  if (doRecord.ttl) {
    standardRecord.ttl = doRecord.ttl;
  }
  
  // Type-specific fields
  switch (doRecord.type) {
    case 'MX':
      if (doRecord.priority !== undefined) {
        standardRecord.priority = doRecord.priority;
      }
      break;
      
    case 'SRV':
      if (doRecord.priority !== undefined) {
        standardRecord.priority = doRecord.priority;
      }
      if (doRecord.weight !== undefined) {
        standardRecord.weight = doRecord.weight;
      }
      if (doRecord.port !== undefined) {
        standardRecord.port = doRecord.port;
      }
      break;
      
    case 'CAA':
      if (doRecord.flags !== undefined) {
        standardRecord.flags = doRecord.flags;
      }
      if (doRecord.tag !== undefined) {
        standardRecord.tag = doRecord.tag;
      }
      break;
  }
  
  logger.trace(`digitalocean.converter: Converted to standard format: ${JSON.stringify(standardRecord)}`);
  return standardRecord;
}

module.exports = {
  convertToDigitalOceanFormat,
  convertRecord
};