/**
 * Utility functions for Traefik DNS Manager
 */
const logger = require('./logger');
const { LOG_LEVELS } = require('./logger');

/**
 * Extract hostnames from a Traefik router rule
 * Supports both v1 and v2 formats
 */
function extractHostnamesFromRule(rule) {
  logger.trace(`utils.extractHostnamesFromRule: Extracting hostnames from rule: ${rule}`);
  
  const hostnames = [];
  
  // Handle Traefik v2 format: Host(`example.com`)
  const v2HostRegex = /Host\(`([^`]+)`\)/g;
  let match;
  
  while ((match = v2HostRegex.exec(rule)) !== null) {
    logger.trace(`utils.extractHostnamesFromRule: Found v2 hostname: ${match[1]}`);
    hostnames.push(match[1]);
  }
  
  // Handle Traefik v1 format: Host:example.com
  const v1HostRegex = /Host:([a-zA-Z0-9.-]+)/g;
  
  while ((match = v1HostRegex.exec(rule)) !== null) {
    logger.trace(`utils.extractHostnamesFromRule: Found v1 hostname: ${match[1]}`);
    hostnames.push(match[1]);
  }
  
  logger.trace(`utils.extractHostnamesFromRule: Extracted ${hostnames.length} hostnames: ${hostnames.join(', ')}`);
  return hostnames;
}

/**
 * Check if a hostname is an apex/root domain
 * @param {string} hostname - The hostname to check
 * @param {string} zone - The zone name
 * @returns {boolean} - True if the hostname is an apex domain
 */
function isApexDomain(hostname, zone) {
  logger.trace(`utils.isApexDomain: Checking if ${hostname} is apex domain for zone ${zone}`);
  
  // Remove trailing dot if present
  const cleanHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const cleanZone = zone.endsWith('.') ? zone.slice(0, -1) : zone;
  
  logger.trace(`utils.isApexDomain: Cleaned hostname: ${cleanHostname}, cleaned zone: ${cleanZone}`);
  
  // If the hostname equals the zone, it's an apex domain
  const isApex = cleanHostname === cleanZone;
  logger.trace(`utils.isApexDomain: Result: ${isApex}`);
  
  return isApex;
}

/**
 * Extract DNS configuration from container labels
 */
function extractDnsConfigFromLabels(labels, config, hostname) {
  logger.trace(`utils.extractDnsConfigFromLabels: Extracting DNS config for ${hostname}`);
  logger.trace(`utils.extractDnsConfigFromLabels: Label count: ${Object.keys(labels).length}`);
  
  if (logger.level >= LOG_LEVELS.TRACE) {
    // In TRACE mode, log all DNS-related labels
    const dnsLabels = Object.entries(labels)
      .filter(([key]) => key.startsWith(config.dnsLabelPrefix))
      .map(([key, value]) => `${key}=${value}`);
      
    logger.trace(`utils.extractDnsConfigFromLabels: DNS-related labels: ${dnsLabels.length ? dnsLabels.join(', ') : 'none'}`);
  }
  
  const prefix = config.dnsLabelPrefix;
  
  // Check if this is an apex domain
  const isApex = isApexDomain(hostname, config.cloudflareZone);
  
  // Determine record type - first from specific labels, then from default
  let recordType = labels[`${prefix}type`];
  if (!recordType) {
    recordType = isApex ? 'A' : config.defaultRecordType;
    logger.trace(`utils.extractDnsConfigFromLabels: Using default record type: ${recordType}`);
  } else {
    logger.trace(`utils.extractDnsConfigFromLabels: Using label-specified record type: ${recordType}`);
  }
  
  // Get defaults for this record type
  const defaults = config.getDefaultsForType(recordType);
  logger.trace(`utils.extractDnsConfigFromLabels: Using defaults for type ${recordType}: ${JSON.stringify(defaults)}`);
  
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
      logger.trace(`utils.extractDnsConfigFromLabels: Converting to A record for apex domain`);
      
      // Get IP if available, otherwise set flag for async IP lookup
      const ip = config.getPublicIPSync();
      if (ip) {
        recordConfig.content = ip;
        logger.trace(`utils.extractDnsConfigFromLabels: Using IP from cache: ${ip}`);
      } else {
        // Flag this record as needing async IP lookup
        recordConfig.needsIpLookup = true;
        recordConfig.content = 'pending'; // Temporary placeholder
        logger.trace(`utils.extractDnsConfigFromLabels: Flagging for async IP lookup`);
      }
      
      logger.debug(`Apex domain detected for ${hostname}, using A record with IP: ${recordConfig.content || 'to be determined'}`);
    } else {
      recordConfig.content = defaults.content;
      logger.trace(`utils.extractDnsConfigFromLabels: Using default content: ${defaults.content}`);
    }
  } else {
    recordConfig.content = content;
    logger.trace(`utils.extractDnsConfigFromLabels: Using label-specified content: ${content}`);
  }
  
  // Handle proxied status
  if (['A', 'AAAA', 'CNAME'].includes(recordConfig.type)) {
    const proxiedLabel = labels[`${prefix}proxied`];
    if (proxiedLabel !== undefined) {
      recordConfig.proxied = proxiedLabel !== 'false';
      logger.trace(`utils.extractDnsConfigFromLabels: Using label-specified proxied status: ${recordConfig.proxied}`);
    } else {
      recordConfig.proxied = defaults.proxied;
      logger.trace(`utils.extractDnsConfigFromLabels: Using default proxied status: ${defaults.proxied}`);
    }
  }
  
  // Add type-specific fields
  switch (recordConfig.type) {
    case 'MX':
      recordConfig.priority = parseInt(
        labels[`${prefix}priority`] || defaults.priority, 
        10
      );
      logger.trace(`utils.extractDnsConfigFromLabels: MX priority set to ${recordConfig.priority}`);
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
      logger.trace(`utils.extractDnsConfigFromLabels: SRV fields - priority: ${recordConfig.priority}, weight: ${recordConfig.weight}, port: ${recordConfig.port}`);
      break;
      
    case 'CAA':
      recordConfig.flags = parseInt(
        labels[`${prefix}flags`] || defaults.flags, 
        10
      );
      recordConfig.tag = labels[`${prefix}tag`] || defaults.tag;
      logger.trace(`utils.extractDnsConfigFromLabels: CAA fields - flags: ${recordConfig.flags}, tag: ${recordConfig.tag}`);
      break;
  }
  
  logger.trace(`utils.extractDnsConfigFromLabels: Final record config: ${JSON.stringify(recordConfig)}`);
  return recordConfig;
}

module.exports = {
  extractHostnamesFromRule,
  extractDnsConfigFromLabels,
  isApexDomain
};