/**
 * DNS-related utility functions
 */
const logger = require('./logger');
const { LOG_LEVELS } = require('./logger');

/**
 * Check if a hostname is an apex/root domain
 * @param {string} hostname - The hostname to check
 * @param {string} zone - The zone name
 * @returns {boolean} - True if the hostname is an apex domain
 */
function isApexDomain(hostname, zone) {
  logger.trace(`dns.isApexDomain: Checking if ${hostname} is apex domain for zone ${zone}`);
  
  // Remove trailing dot if present
  const cleanHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const cleanZone = zone.endsWith('.') ? zone.slice(0, -1) : zone;
  
  logger.trace(`dns.isApexDomain: Cleaned hostname: ${cleanHostname}, cleaned zone: ${cleanZone}`);
  
  // If the hostname equals the zone, it's an apex domain
  const isApex = cleanHostname === cleanZone;
  logger.trace(`dns.isApexDomain: Result: ${isApex}`);
  
  return isApex;
}

/**
 * Extract DNS configuration from container labels
 */
function extractDnsConfigFromLabels(labels, config, hostname) {
  logger.trace(`dns.extractDnsConfigFromLabels: Extracting DNS config for ${hostname}`);
  logger.trace(`dns.extractDnsConfigFromLabels: Label count: ${Object.keys(labels).length}`);
  
  if (logger.level >= LOG_LEVELS.TRACE) {
    // In TRACE mode, log all DNS-related labels
    const dnsLabels = Object.entries(labels)
      .filter(([key]) => key.startsWith(config.dnsLabelPrefix))
      .map(([key, value]) => `${key}=${value}`);
      
    logger.trace(`dns.extractDnsConfigFromLabels: DNS-related labels: ${dnsLabels.length ? dnsLabels.join(', ') : 'none'}`);
  }
  
  const prefix = config.dnsLabelPrefix;
  
  // Check if this is an apex domain
  const isApex = isApexDomain(hostname, config.cloudflareZone);
  
  // Determine record type - first from specific labels, then from default
  let recordType = labels[`${prefix}type`];
  if (!recordType) {
    recordType = isApex ? 'A' : config.defaultRecordType;
    logger.trace(`dns.extractDnsConfigFromLabels: Using default record type: ${recordType}`);
  } else {
    logger.trace(`dns.extractDnsConfigFromLabels: Using label-specified record type: ${recordType}`);
  }
  
  // Get defaults for this record type
  const defaults = config.getDefaultsForType(recordType);
  logger.trace(`dns.extractDnsConfigFromLabels: Using defaults for type ${recordType}: ${JSON.stringify(defaults)}`);
  
  // Build basic record config
  const recordConfig = {
    type: recordType,
    name: hostname,
    ttl: parseInt(labels[`${prefix}ttl`] || defaults.ttl, 10)
  };
  
  // Handle content based on record type and apex status
  let content = labels[`${prefix}content`];
  
  // If content isn't specified in labels
  if (!content) {
    if (isApex && (recordType === 'CNAME' || recordType === 'A')) {
      // For apex domains, we should use an A record
      recordConfig.type = 'A';
      logger.trace(`dns.extractDnsConfigFromLabels: Converting to A record for apex domain`);
      
      // Get IP if available, otherwise set flag for async IP lookup
      const ip = config.getPublicIPSync();
      if (ip) {
        recordConfig.content = ip;
        logger.trace(`dns.extractDnsConfigFromLabels: Using IP from cache: ${ip}`);
      } else {
        // Flag this record as needing async IP lookup
        recordConfig.needsIpLookup = true;
        recordConfig.content = 'pending'; // Temporary placeholder
        logger.trace(`dns.extractDnsConfigFromLabels: Flagging for async IP lookup`);
      }
      
      logger.debug(`Apex domain detected for ${hostname}, using A record with IP: ${recordConfig.content || 'to be determined'}`);
    } else {
      recordConfig.content = defaults.content;
      logger.trace(`dns.extractDnsConfigFromLabels: Using default content: ${defaults.content}`);
    }
  } else {
    recordConfig.content = content;
    logger.trace(`dns.extractDnsConfigFromLabels: Using label-specified content: ${content}`);
  }
  
  // Handle proxied status
  if (['A', 'AAAA', 'CNAME'].includes(recordConfig.type)) {
    const proxiedLabel = labels[`${prefix}proxied`];
    logger.debug(`Processing proxied status for ${hostname}: Label value = ${proxiedLabel}`);
    
    // Create a simple cache to track if we've already logged this hostname's proxied status
    if (!global.proxiedStatusCache) {
      global.proxiedStatusCache = {};
    }
    
    const previousValue = global.proxiedStatusCache[hostname];
    
    if (proxiedLabel !== undefined) {
      // Explicitly check against string 'false' to ensure proper conversion to boolean
      // This is a critical conversion point - must be clear and reliable
      if (proxiedLabel === 'false') {
        recordConfig.proxied = false;
        
        // Only log at INFO level the first time or if value changed from true
        if (previousValue === undefined || previousValue === true) {
          logger.info(`🔒 DNS record for ${hostname}: Setting proxied=false from label`);
        } else {
          // Use debug level for repeated information
          logger.debug(`DNS record for ${hostname}: Setting proxied=false from label (unchanged)`);
        }
        
        // Update the cache
        global.proxiedStatusCache[hostname] = false;
      } else {
        recordConfig.proxied = true;
        
        // Only log at INFO if value changed from false to true
        if (previousValue === false) {
          logger.info(`DNS record for ${hostname}: Setting proxied=true from label (changed from false)`);
        } else {
          logger.debug(`DNS record for ${hostname}: Setting proxied=true from label value '${proxiedLabel}'`);
        }
        
        // Update the cache
        global.proxiedStatusCache[hostname] = true;
      }
    } else {
      recordConfig.proxied = defaults.proxied;
      
      // Only log at INFO if previously had explicit value
      if (previousValue !== undefined) {
        logger.info(`DNS record for ${hostname}: Reverting to default proxied=${defaults.proxied} (had explicit setting before)`);
      } else {
        logger.debug(`DNS record for ${hostname}: Using default proxied=${defaults.proxied}`);
      }
      
      // Update the cache
      global.proxiedStatusCache[hostname] = undefined;
    }
  }
  
  // Add type-specific fields
  switch (recordConfig.type) {
    case 'MX':
      recordConfig.priority = parseInt(
        labels[`${prefix}priority`] || defaults.priority, 
        10
      );
      logger.trace(`dns.extractDnsConfigFromLabels: MX priority set to ${recordConfig.priority}`);
      break;
      
    case 'SRV':
      recordConfig.priority = parseInt(
        labels[`${prefix}priority`] || defaults.priority, 
        10
      );
      recordConfig.weight = parseInt(
        labels[`${prefix}weight`] || defaults.weight, 
        10
      );
      recordConfig.port = parseInt(
        labels[`${prefix}port`] || defaults.port, 
        10
      );
      logger.trace(`dns.extractDnsConfigFromLabels: SRV fields - priority: ${recordConfig.priority}, weight: ${recordConfig.weight}, port: ${recordConfig.port}`);
      break;
      
    case 'CAA':
      recordConfig.flags = parseInt(
        labels[`${prefix}flags`] || defaults.flags, 
        10
      );
      recordConfig.tag = labels[`${prefix}tag`] || defaults.tag;
      logger.trace(`dns.extractDnsConfigFromLabels: CAA fields - flags: ${recordConfig.flags}, tag: ${recordConfig.tag}`);
      break;
  }
  
  logger.trace(`dns.extractDnsConfigFromLabels: Final record config: ${JSON.stringify(recordConfig)}`);
  return recordConfig;
}

module.exports = {
  isApexDomain,
  extractDnsConfigFromLabels
};