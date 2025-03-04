/**
 * Cloudflare-specific record validation utilities
 */
const logger = require('../../logger');

/**
 * Validate a Cloudflare DNS record configuration
 * @param {Object} record - The record to validate
 * @throws {Error} - If validation fails
 */
function validateRecord(record) {
  logger.trace(`cloudflare.validator: Validating record ${record.name} (${record.type})`);
  
  // Common validations
  if (!record.type) {
    logger.trace(`cloudflare.validator: Record type is missing`);
    throw new Error('Record type is required');
  }
  
  if (!record.name) {
    logger.trace(`cloudflare.validator: Record name is missing`);
    throw new Error('Record name is required');
  }
  
  // Type-specific validations
  switch (record.type) {
    case 'A':
      if (!record.content) {
        logger.trace(`cloudflare.validator: IP address is missing for A record`);
        throw new Error('IP address is required for A records');
      }
      
      // Simple IP validation
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(record.content)) {
        logger.trace(`cloudflare.validator: Invalid IPv4 format: ${record.content}`);
        throw new Error(`Invalid IPv4 address format: ${record.content}`);
      }
      break;
      
    case 'AAAA':
      if (!record.content) {
        logger.trace(`cloudflare.validator: IPv6 address is missing for AAAA record`);
        throw new Error('IPv6 address is required for AAAA records');
      }
      break;
      
    case 'CNAME':
    case 'TXT':
    case 'NS':
      if (!record.content) {
        logger.trace(`cloudflare.validator: Content is missing for ${record.type} record`);
        throw new Error(`Content is required for ${record.type} records`);
      }
      break;
      
    case 'MX':
      if (!record.content) {
        logger.trace(`cloudflare.validator: Mail server is missing for MX record`);
        throw new Error('Mail server is required for MX records');
      }
      // Set default priority if missing
      if (record.priority === undefined) {
        logger.trace(`cloudflare.validator: Setting default priority (10) for MX record`);
        record.priority = 10;
      }
      break;
      
    case 'SRV':
      if (!record.content) {
        logger.trace(`cloudflare.validator: Target is missing for SRV record`);
        throw new Error('Target is required for SRV records');
      }
      // Set defaults for SRV fields
      if (record.priority === undefined) {
        logger.trace(`cloudflare.validator: Setting default priority (1) for SRV record`);
        record.priority = 1;
      }
      if (record.weight === undefined) {
        logger.trace(`cloudflare.validator: Setting default weight (1) for SRV record`);
        record.weight = 1;
      }
      if (record.port === undefined) {
        logger.trace(`cloudflare.validator: Port is missing for SRV record`);
        throw new Error('Port is required for SRV records');
      }
      break;
      
    case 'CAA':
      if (!record.content) {
        logger.trace(`cloudflare.validator: Value is missing for CAA record`);
        throw new Error('Value is required for CAA records');
      }
      if (record.flags === undefined) {
        logger.trace(`cloudflare.validator: Setting default flags (0) for CAA record`);
        record.flags = 0;
      }
      if (!record.tag) {
        logger.trace(`cloudflare.validator: Tag is missing for CAA record`);
        throw new Error('Tag is required for CAA records');
      }
      break;
      
    default:
      logger.warn(`Record type ${record.type} may not be fully supported by Cloudflare`);
      logger.trace(`cloudflare.validator: Unknown record type: ${record.type}`);
  }
  
  // Cloudflare-specific validations
  
  // Proxied is only valid for certain record types
  if (record.proxied && !['A', 'AAAA', 'CNAME'].includes(record.type)) {
    logger.warn(`'proxied' is not valid for ${record.type} records. Setting to false.`);
    logger.trace(`cloudflare.validator: Setting proxied=false for ${record.type} record (not supported)`);
    record.proxied = false;
  }
  
  // TTL must be either 1 (automatic) or at least 60 seconds
  if (record.ttl !== 1 && record.ttl < 60) {
    logger.warn(`TTL value ${record.ttl} is too low for Cloudflare. Setting to 60 seconds.`);
    logger.trace(`cloudflare.validator: Adjusting TTL from ${record.ttl} to 60 (minimum)`);
    record.ttl = 60;
  }
  
  logger.trace(`cloudflare.validator: Record validation successful`);
}

module.exports = {
  validateRecord
};