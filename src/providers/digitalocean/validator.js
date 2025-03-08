/**
 * DigitalOcean-specific record validation utilities
 */
const logger = require('../../utils/logger');

/**
 * Validate a DigitalOcean DNS record configuration
 * @param {Object} record - The record to validate
 * @throws {Error} - If validation fails
 */
function validateRecord(record) {
  logger.trace(`digitalocean.validator: Validating record ${record.name} (${record.type})`);
  
  // Common validations
  if (!record.type) {
    logger.trace(`digitalocean.validator: Record type is missing`);
    throw new Error('Record type is required');
  }
  
  if (!record.name) {
    logger.trace(`digitalocean.validator: Record name is missing`);
    throw new Error('Record name is required');
  }
  
  // Type-specific validations
  switch (record.type) {
    case 'A':
      if (!record.content) {
        logger.trace(`digitalocean.validator: IP address is missing for A record`);
        throw new Error('IP address is required for A records');
      }
      
      // Simple IP validation
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(record.content)) {
        logger.trace(`digitalocean.validator: Invalid IPv4 format: ${record.content}`);
        throw new Error(`Invalid IPv4 address format: ${record.content}`);
      }
      break;
      
    case 'AAAA':
      if (!record.content) {
        logger.trace(`digitalocean.validator: IPv6 address is missing for AAAA record`);
        throw new Error('IPv6 address is required for AAAA records');
      }
      break;
      
    case 'CNAME':
      if (!record.content) {
        logger.trace(`digitalocean.validator: Target is missing for CNAME record`);
        throw new Error('Target is required for CNAME records');
      }
      
      // Special handling for CNAME records - DigitalOcean requires fully qualified domain names
      // If the content doesn't end with a dot and doesn't seem to be an absolute domain,
      // we should add a trailing dot
      if (!record.content.endsWith('.') && record.content.includes('.')) {
        logger.debug(`Adding trailing period to CNAME content: ${record.content} → ${record.content}.`);
        record.content = `${record.content}.`;
      }
      break;
      
    case 'TXT':
    case 'NS':
      if (!record.content) {
        logger.trace(`digitalocean.validator: Content is missing for ${record.type} record`);
        throw new Error(`Content is required for ${record.type} records`);
      }
      break;
      
    case 'MX':
      if (!record.content) {
        logger.trace(`digitalocean.validator: Mail server is missing for MX record`);
        throw new Error('Mail server is required for MX records');
      }
      
      // Add trailing dot for MX records if missing
      if (!record.content.endsWith('.') && record.content.includes('.')) {
        logger.debug(`Adding trailing period to MX server: ${record.content} → ${record.content}.`);
        record.content = `${record.content}.`;
      }
      
      // Set default priority if missing
      if (record.priority === undefined) {
        logger.trace(`digitalocean.validator: Setting default priority (10) for MX record`);
        record.priority = 10;
      }
      break;
      
    case 'SRV':
      if (!record.content) {
        logger.trace(`digitalocean.validator: Target is missing for SRV record`);
        throw new Error('Target is required for SRV records');
      }
      
      // Add trailing dot for SRV target if missing
      if (!record.content.endsWith('.') && record.content.includes('.')) {
        logger.debug(`Adding trailing period to SRV target: ${record.content} → ${record.content}.`);
        record.content = `${record.content}.`;
      }
      
      // Set defaults for SRV fields
      if (record.priority === undefined) {
        logger.trace(`digitalocean.validator: Setting default priority (1) for SRV record`);
        record.priority = 1;
      }
      if (record.weight === undefined) {
        logger.trace(`digitalocean.validator: Setting default weight (1) for SRV record`);
        record.weight = 1;
      }
      if (record.port === undefined) {
        logger.trace(`digitalocean.validator: Port is missing for SRV record`);
        throw new Error('Port is required for SRV records');
      }
      break;
      
    case 'CAA':
      if (!record.content) {
        logger.trace(`digitalocean.validator: Value is missing for CAA record`);
        throw new Error('Value is required for CAA records');
      }
      if (record.flags === undefined) {
        logger.trace(`digitalocean.validator: Setting default flags (0) for CAA record`);
        record.flags = 0;
      }
      if (!record.tag) {
        logger.trace(`digitalocean.validator: Tag is missing for CAA record`);
        throw new Error('Tag is required for CAA records');
      }
      break;
      
    default:
      logger.warn(`Record type ${record.type} may not be fully supported by DigitalOcean`);
      logger.trace(`digitalocean.validator: Unknown record type: ${record.type}`);
  }
  
  // DigitalOcean-specific validations
  
  // Silently remove 'proxied' property if present since DigitalOcean doesn't support proxying
  if (record.proxied !== undefined) {
    delete record.proxied;
    logger.trace(`digitalocean.validator: Removed 'proxied' property as DigitalOcean doesn't support it`);
  }
  
  // DigitalOcean requires TTL to be at least 30 seconds
  if (record.ttl !== undefined && record.ttl < 30) {
    logger.warn(`TTL value ${record.ttl} is too low for DigitalOcean DNS. Setting to 30 seconds (minimum).`);
    logger.trace(`digitalocean.validator: Adjusting TTL from ${record.ttl} to 30 (minimum)`);
    record.ttl = 30;
  }
  
  logger.trace(`digitalocean.validator: Record validation successful`);
}

module.exports = {
  validateRecord
};