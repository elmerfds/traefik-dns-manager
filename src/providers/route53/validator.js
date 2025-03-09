/**
 * Route53-specific record validation utilities
 */
const logger = require('../../utils/logger');

/**
 * Validate a Route53 DNS record configuration
 * @param {Object} record - The record to validate
 * @throws {Error} - If validation fails
 */
function validateRecord(record) {
  logger.trace(`route53.validator: Validating record ${record.name} (${record.type})`);
  
  // Common validations
  if (!record.type) {
    logger.trace(`route53.validator: Record type is missing`);
    throw new Error('Record type is required');
  }
  
  if (!record.name) {
    logger.trace(`route53.validator: Record name is missing`);
    throw new Error('Record name is required');
  }
  
  // Type-specific validations
  switch (record.type) {
    case 'A':
      if (!record.content) {
        logger.trace(`route53.validator: IP address is missing for A record`);
        throw new Error('IP address is required for A records');
      }
      
      // Simple IP validation
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(record.content)) {
        logger.trace(`route53.validator: Invalid IPv4 format: ${record.content}`);
        throw new Error(`Invalid IPv4 address format: ${record.content}`);
      }
      break;
      
    case 'AAAA':
      if (!record.content) {
        logger.trace(`route53.validator: IPv6 address is missing for AAAA record`);
        throw new Error('IPv6 address is required for AAAA records');
      }
      break;
      
    case 'CNAME':
      if (!record.content) {
        logger.trace(`route53.validator: Target is missing for CNAME record`);
        throw new Error('Target is required for CNAME records');
      }
      break;
      
    case 'TXT':
    case 'NS':
      if (!record.content) {
        logger.trace(`route53.validator: Content is missing for ${record.type} record`);
        throw new Error(`Content is required for ${record.type} records`);
      }
      break;
      
    case 'MX':
      if (!record.content) {
        logger.trace(`route53.validator: Mail server is missing for MX record`);
        throw new Error('Mail server is required for MX records');
      }
      
      // Set default priority if missing
      if (record.priority === undefined) {
        logger.trace(`route53.validator: Setting default priority (10) for MX record`);
        record.priority = 10;
      }
      break;
      
    case 'SRV':
      if (!record.content) {
        logger.trace(`route53.validator: Target is missing for SRV record`);
        throw new Error('Target is required for SRV records');
      }
      
      // Set defaults for SRV fields
      if (record.priority === undefined) {
        logger.trace(`route53.validator: Setting default priority (1) for SRV record`);
        record.priority = 1;
      }
      if (record.weight === undefined) {
        logger.trace(`route53.validator: Setting default weight (1) for SRV record`);
        record.weight = 1;
      }
      if (record.port === undefined) {
        logger.trace(`route53.validator: Port is missing for SRV record`);
        throw new Error('Port is required for SRV records');
      }
      break;
      
    case 'CAA':
      if (!record.content) {
        logger.trace(`route53.validator: Value is missing for CAA record`);
        throw new Error('Value is required for CAA records');
      }
      if (record.flags === undefined) {
        logger.trace(`route53.validator: Setting default flags (0) for CAA record`);
        record.flags = 0;
      }
      if (!record.tag) {
        logger.trace(`route53.validator: Tag is missing for CAA record`);
        throw new Error('Tag is required for CAA records');
      }
      break;
      
    default:
      logger.warn(`Record type ${record.type} may not be fully supported by Route53`);
      logger.trace(`route53.validator: Unknown record type: ${record.type}`);
  }
  
  // Route53-specific validations
  
  // Remove proxied flag if present (Route53 doesn't support proxying)
  if (record.proxied !== undefined) {
    logger.warn(`'proxied' flag is not valid for Route53 records. This flag will be ignored.`);
    logger.trace(`route53.validator: Removing 'proxied' property as Route53 doesn't support it`);
    delete record.proxied;
  }
  
  // TTL can't be less than 60 seconds in Route53
  if (record.ttl !== undefined && record.ttl < 60) {
    logger.warn(`TTL value ${record.ttl} is too low for Route53. Setting to 60 seconds (minimum).`);
    logger.trace(`route53.validator: Adjusting TTL from ${record.ttl} to 60 (minimum)`);
    record.ttl = 60;
  }
  
  // If TTL is missing, set a default
  if (record.ttl === undefined) {
    logger.trace(`route53.validator: Setting default TTL (300) for record`);
    record.ttl = 300;
  }
  
  logger.trace(`route53.validator: Record validation successful`);
}

module.exports = {
  validateRecord
};