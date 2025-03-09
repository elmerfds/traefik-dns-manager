/**
 * Route53 record format converter utilities
 * Handles conversion between internal format and AWS Route53 API format
 */
const logger = require('../../utils/logger');

/**
 * Convert standard record format to Route53 API format
 * @param {Object} record - Record in standard format
 * @param {string} zone - The zone name
 * @returns {Object} - Record in Route53 format
 */
function convertToRoute53Format(record, zone) {
  logger.trace(`route53.converter: Converting record to Route53 format: ${JSON.stringify(record)}`);
  
  // Ensure zone has trailing dot
  const zoneName = zone.endsWith('.') ? zone : `${zone}.`;
  
  // Basic record format for Route53
  const route53Record = {
    Name: ensureTrailingDot(record.name, zoneName),
    Type: record.type,
    TTL: record.ttl || 300,
    ResourceRecords: []
  };
  
  // Process record content based on type
  switch (record.type) {
    case 'A':
    case 'AAAA':
    case 'TXT':
    case 'NS':
      route53Record.ResourceRecords.push({
        Value: record.content
      });
      break;
      
    case 'CNAME':
      // Route53 requires CNAME values to end with a dot
      route53Record.ResourceRecords.push({
        Value: ensureTrailingDot(record.content)
      });
      break;
      
    case 'MX':
      route53Record.ResourceRecords.push({
        Value: `${record.priority || 10} ${ensureTrailingDot(record.content)}`
      });
      break;
      
    case 'SRV':
      route53Record.ResourceRecords.push({
        Value: `${record.priority || 10} ${record.weight || 10} ${record.port || 80} ${ensureTrailingDot(record.content)}`
      });
      break;
      
    case 'CAA':
      route53Record.ResourceRecords.push({
        Value: `${record.flags || 0} ${record.tag || 'issue'} "${record.content}"`
      });
      break;
      
    default:
      // Fallback for any other record types
      if (record.content) {
        route53Record.ResourceRecords.push({
          Value: record.content
        });
      }
  }
  
  logger.trace(`route53.converter: Converted to Route53 format: ${JSON.stringify(route53Record)}`);
  return route53Record;
}

/**
 * Convert Route53 record format to standard format
 * @param {Object} route53Record - Record in Route53 format
 * @returns {Object} - Record in standard format
 */
function convertRecord(route53Record) {
  logger.trace(`route53.converter: Converting from Route53 format: ${JSON.stringify(route53Record)}`);
  
  // Basic record format
  const standardRecord = {
    id: `${route53Record.Name}:${route53Record.Type}`,
    type: route53Record.Type,
    name: route53Record.Name,
    ttl: route53Record.TTL
  };
  
  // Process resource records based on type
  if (route53Record.ResourceRecords && route53Record.ResourceRecords.length > 0) {
    const value = route53Record.ResourceRecords[0].Value;
    
    // Process content based on record type
    switch (route53Record.Type) {
      case 'MX':
        // Extract priority and content from MX record
        const mxParts = value.split(' ');
        standardRecord.priority = parseInt(mxParts[0], 10);
        standardRecord.content = mxParts.slice(1).join(' ');
        break;
        
      case 'SRV':
        // Extract SRV record fields
        const srvParts = value.split(' ');
        standardRecord.priority = parseInt(srvParts[0], 10);
        standardRecord.weight = parseInt(srvParts[1], 10);
        standardRecord.port = parseInt(srvParts[2], 10);
        standardRecord.content = srvParts.slice(3).join(' ');
        break;
        
      case 'CAA':
        // Extract CAA record fields
        const matches = value.match(/(\d+)\s+(\w+)\s+"(.+)"/);
        if (matches) {
          standardRecord.flags = parseInt(matches[1], 10);
          standardRecord.tag = matches[2];
          standardRecord.content = matches[3];
        } else {
          // If regex doesn't match, fall back to simple splitting
          const caaParts = value.split(' ');
          standardRecord.flags = parseInt(caaParts[0], 10);
          standardRecord.tag = caaParts[1];
          standardRecord.content = caaParts.slice(2).join(' ').replace(/"/g, '');
        }
        break;
      
      case 'TXT':
        // Remove quotes if they exist
        standardRecord.content = value.replace(/^"(.*)"$/, '$1');
        break;
        
      default:
        standardRecord.content = value;
    }
  } else if (route53Record.AliasTarget) {
    // Handle Route53 alias records
    standardRecord.content = route53Record.AliasTarget.DNSName;
    standardRecord.isAlias = true;
    standardRecord.aliasTarget = {
      hostedZoneId: route53Record.AliasTarget.HostedZoneId,
      dnsName: route53Record.AliasTarget.DNSName,
      evaluateTargetHealth: route53Record.AliasTarget.EvaluateTargetHealth
    };
  }
  
  // Remove trailing dots from names and content
  if (standardRecord.name && standardRecord.name.endsWith('.')) {
    standardRecord.name = standardRecord.name.slice(0, -1);
  }
  
  if (standardRecord.content && typeof standardRecord.content === 'string' && standardRecord.content.endsWith('.')) {
    standardRecord.content = standardRecord.content.slice(0, -1);
  }
  
  logger.trace(`route53.converter: Converted to standard format: ${JSON.stringify(standardRecord)}`);
  return standardRecord;
}

/**
 * Ensure a domain name ends with a trailing dot (required by Route53)
 * @param {string} name - Domain name
 * @param {string} zone - Zone name (optional, for appending to subdomains)
 * @returns {string} - Domain name with trailing dot
 */
function ensureTrailingDot(name, zone = null) {
  // If name already has trailing dot, return as is
  if (name.endsWith('.')) {
    return name;
  }
  
  // If zone is provided and name doesn't include zone, append it
  if (zone && !name.includes(zone.replace(/\.$/, ''))) {
    // Check if this is the apex domain
    if (name === zone.replace(/\.$/, '')) {
      return zone.endsWith('.') ? zone : `${zone}.`;
    }
    
    // For subdomains, combine name and zone
    const zonePart = zone.endsWith('.') ? zone : `${zone}.`;
    return `${name}.${zonePart}`;
  }
  
  // Otherwise just add the trailing dot
  return `${name}.`;
}

module.exports = {
  convertToRoute53Format,
  convertRecord,
  ensureTrailingDot
};