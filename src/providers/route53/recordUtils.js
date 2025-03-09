/**
 * Record utility functions for Route53 provider
 */
const logger = require('../../utils/logger');

/**
 * Standardize Route53 records to internal format
 */
function standardizeRecords(route53Records) {
  return route53Records.map(record => {
    // Create a standardized record with common fields
    const standardRecord = {
      id: `${record.Name}:${record.Type}`, // Route53 doesn't have record IDs, create a composite key
      type: record.Type,
      name: record.Name.endsWith('.') ? record.Name.slice(0, -1) : record.Name,
      ttl: record.TTL || 300
    };
    
    // Process resource records based on type
    if (record.ResourceRecords && record.ResourceRecords.length > 0) {
      // For most record types with simple values
      if (['A', 'AAAA', 'CNAME', 'TXT', 'NS'].includes(record.Type)) {
        standardRecord.content = record.ResourceRecords[0].Value;
        
        // For TXT records, remove quotes if present
        if (record.Type === 'TXT' && standardRecord.content.startsWith('"') && standardRecord.content.endsWith('"')) {
          standardRecord.content = standardRecord.content.slice(1, -1);
        }
      } 
      // For MX records, extract priority and content
      else if (record.Type === 'MX') {
        const parts = record.ResourceRecords[0].Value.split(' ');
        standardRecord.priority = parseInt(parts[0], 10);
        standardRecord.content = parts.slice(1).join(' ');
      }
      // For SRV records, parse the complex format
      else if (record.Type === 'SRV') {
        const parts = record.ResourceRecords[0].Value.split(' ');
        standardRecord.priority = parseInt(parts[0], 10);
        standardRecord.weight = parseInt(parts[1], 10);
        standardRecord.port = parseInt(parts[2], 10);
        standardRecord.content = parts[3];
      }
      // For CAA records, extract flags, tag, and value
      else if (record.Type === 'CAA') {
        const parts = record.ResourceRecords[0].Value.split(' ');
        standardRecord.flags = parseInt(parts[0], 10);
        standardRecord.tag = parts[1].replace(/"/g, '');
        standardRecord.content = parts[2].replace(/"/g, '');
      }
    }
    // Handle alias records
    else if (record.AliasTarget) {
      standardRecord.content = record.AliasTarget.DNSName;
      standardRecord.isAlias = true;
      standardRecord.aliasTarget = {
        hostedZoneId: record.AliasTarget.HostedZoneId,
        dnsName: record.AliasTarget.DNSName,
        evaluateTargetHealth: record.AliasTarget.EvaluateTargetHealth
      };
    }
    
    return standardRecord;
  });
}

/**
 * Check if a record needs to be updated
 */
function recordNeedsUpdate(existing, newRecord) {
  logger.trace(`Route53Provider.recordNeedsUpdate: Comparing records for ${newRecord.name}`);
  logger.trace(`Route53Provider.recordNeedsUpdate: Existing: ${JSON.stringify(existing)}`);
  logger.trace(`Route53Provider.recordNeedsUpdate: New: ${JSON.stringify(newRecord)}`);

  // Basic field comparison
  let needsUpdate = false;

  // Compare content/data (normalize and remove trailing dots for comparison)
  let existingContent = existing.content;
  let newContent = newRecord.content;

  // Normalize record contents for comparison
  if (existingContent && existingContent.endsWith('.')) {
    existingContent = existingContent.slice(0, -1);
  }

  if (newContent && newContent.endsWith('.')) {
    newContent = newContent.slice(0, -1);
  }

  if (existingContent !== newContent) {
    logger.trace(`Route53Provider.recordNeedsUpdate: Content different: ${existingContent} vs ${newContent}`);
    needsUpdate = true;
  }

  // Compare TTL
  if (existing.ttl !== newRecord.ttl) {
    logger.trace(`Route53Provider.recordNeedsUpdate: TTL different: ${existing.ttl} vs ${newRecord.ttl}`);
    needsUpdate = true;
  }

  // Type-specific field comparisons
  switch (newRecord.type) {
    case 'MX':
      if (existing.priority !== newRecord.priority) {
        logger.trace(`Route53Provider.recordNeedsUpdate: MX priority different: ${existing.priority} vs ${newRecord.priority}`);
        needsUpdate = true;
      }
      break;

    case 'SRV':
      if (existing.priority !== newRecord.priority ||
          existing.weight !== newRecord.weight ||
          existing.port !== newRecord.port) {
        logger.trace(`Route53Provider.recordNeedsUpdate: SRV fields different`);
        needsUpdate = true;
      }
      break;

    case 'CAA':
      if (existing.flags !== newRecord.flags ||
          existing.tag !== newRecord.tag) {
        logger.trace(`Route53Provider.recordNeedsUpdate: CAA fields different`);
        needsUpdate = true;
      }
      break;
  }

  // If an update is needed, log the specific differences at DEBUG level
  if (needsUpdate && logger.level >= 3) { // DEBUG level or higher
    logger.debug(`Record ${newRecord.name} needs update:`);
    if (existingContent !== newContent) 
      logger.debug(` - Content: ${existingContent} → ${newContent}`);
    if (existing.ttl !== newRecord.ttl) 
      logger.debug(` - TTL: ${existing.ttl} → ${newRecord.ttl}`);

    // Log type-specific field changes
    switch (newRecord.type) {
      case 'MX':
        if (existing.priority !== newRecord.priority)
          logger.debug(` - Priority: ${existing.priority} → ${newRecord.priority}`);
        break;
        
      case 'SRV':
        if (existing.priority !== newRecord.priority)
          logger.debug(` - Priority: ${existing.priority} → ${newRecord.priority}`);
        if (existing.weight !== newRecord.weight)
          logger.debug(` - Weight: ${existing.weight} → ${newRecord.weight}`);
        if (existing.port !== newRecord.port)
          logger.debug(` - Port: ${existing.port} → ${newRecord.port}`);
        break;
        
      case 'CAA':
        if (existing.flags !== newRecord.flags)
          logger.debug(` - Flags: ${existing.flags} → ${newRecord.flags}`);
        if (existing.tag !== newRecord.tag)
          logger.debug(` - Tag: ${existing.tag} → ${newRecord.tag}`);
        break;
    }
  }

  logger.trace(`Route53Provider.recordNeedsUpdate: Final result - needs update: ${needsUpdate}`);
  return needsUpdate;
}

module.exports = {
  standardizeRecords,
  recordNeedsUpdate
};