/**
 * Find a record in the cache
 * Override the base method to handle DigitalOcean's @ symbol for apex domains
 * and trailing dots for domains
 */
findRecordInCache(type, name) {
  // First normalize the name to handle apex domain scenarios
  const domainPart = `.${this.domain}`;
  
  // If the name ends with the domain, extract the subdomain part
  let recordName = name;
  if (name.endsWith(domainPart)) {
    recordName = name.slice(0, -domainPart.length);
    // If the name is exactly the domain, use @ for the apex
    if (recordName === '') {
      recordName = '@';
    }
  }
  
  logger.trace(`DigitalOceanProvider.findRecordInCache: Looking for ${type} record with name ${recordName}`);
  
  // For records that store the content with a trailing dot (like CNAME),
  // we need to handle both forms in our comparison
  const record = this.recordCache.records.find(r => 
    r.type === type && r.name === recordName
  );
  
  if (record) {
    logger.trace(`DigitalOceanProvider.findRecordInCache: Found record with ID ${record.id}`);
    return record;
  }
  
  // Try once more without trailing dot for CNAME/MX/SRV records if we didn't find anything
  if (['CNAME', 'MX', 'SRV'].includes(type)) {
    logger.trace(`DigitalOceanProvider.findRecordInCache: Trying alternate search without trailing dot`);
    
    return this.recordCache.records.find(r => {
      if (r.type !== type || r.name !== recordName) return false;
      
      // Compare content with and without trailing dot
      if (r.data && typeof r.data === 'string') {
        const normalizedData = r.data.endsWith('.') ? r.data.slice(0, -1) : r.data;
        logger.trace(`DigitalOceanProvider.findRecordInCache: Comparing normalized data: ${normalizedData}`);
      }
      
      return r.type === type && r.name === recordName;
    });
  }
  
  logger.trace(`DigitalOceanProvider.findRecordInCache: No record found`);
  return null;
}

/**
 * Record needs update comparison that handles trailing dots properly
 */
recordNeedsUpdate(existing, newRecord) {
  logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Comparing records for ${newRecord.name}`);
  logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Existing: ${JSON.stringify(existing)}`);
  logger.trace(`DigitalOceanProvider.recordNeedsUpdate: New: ${JSON.stringify(newRecord)}`);
  
  // Extract the correct content field based on record type
  let existingContent = existing.data;
  let newContent = newRecord.content;
  
  // Handle trailing dots for content comparison in relevant record types
  if (['CNAME', 'MX', 'SRV', 'NS'].includes(newRecord.type)) {
    // Normalize both contents by removing trailing dots for comparison
    if (existingContent && existingContent.endsWith('.')) {
      existingContent = existingContent.slice(0, -1);
    }
    if (newContent && newContent.endsWith('.')) {
      newContent = newContent.slice(0, -1);
    }
    
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Normalized existing content: ${existingContent}`);
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Normalized new content: ${newContent}`);
  }
  
  // Compare basic fields
  let needsUpdate = false;
  
  // Compare content/data
  if (existingContent !== newContent) {
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Content different: ${existingContent} vs ${newContent}`);
    needsUpdate = true;
  }
  
  // Compare TTL
  if (existing.ttl !== newRecord.ttl) {
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: TTL different: ${existing.ttl} vs ${newRecord.ttl}`);
    needsUpdate = true;
  }
  
  // Type-specific field comparisons
  switch (newRecord.type) {
    case 'MX':
      if (existing.priority !== newRecord.priority) {
        logger.trace(`DigitalOceanProvider.recordNeedsUpdate: MX priority different: ${existing.priority} vs ${newRecord.priority}`);
        needsUpdate = true;
      }
      break;
      
    case 'SRV':
      if (existing.priority !== newRecord.priority ||
          existing.weight !== newRecord.weight ||
          existing.port !== newRecord.port) {
        logger.trace(`DigitalOceanProvider.recordNeedsUpdate: SRV fields different`);
        needsUpdate = true;
      }
      break;
      
    case 'CAA':
      if (existing.flags !== newRecord.flags ||
          existing.tag !== newRecord.tag) {
        logger.trace(`DigitalOceanProvider.recordNeedsUpdate: CAA fields different`);
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
  
  logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Final result - needs update: ${needsUpdate}`);
  return needsUpdate;
}

module.exports = DigitalOceanProvider;