/**
 * Utility functions for Traefik DNS Manager
 */

/**
 * Extract hostnames from a Traefik router rule
 * Supports both v1 and v2 formats
 */
function extractHostnamesFromRule(rule) {
  const hostnames = [];
  
  // Handle Traefik v2 format: Host(`example.com`)
  const v2HostRegex = /Host\(`([^`]+)`\)/g;
  let match;
  
  while ((match = v2HostRegex.exec(rule)) !== null) {
    hostnames.push(match[1]);
  }
  
  // Handle Traefik v1 format: Host:example.com
  const v1HostRegex = /Host:([a-zA-Z0-9.-]+)/g;
  
  while ((match = v1HostRegex.exec(rule)) !== null) {
    hostnames.push(match[1]);
  }
  
  return hostnames;
}

/**
 * Check if a hostname is an apex/root domain
 * @param {string} hostname - The hostname to check
 * @param {string} zone - The zone name
 * @returns {boolean} - True if the hostname is an apex domain
 */
function isApexDomain(hostname, zone) {
  // Remove trailing dot if present
  const cleanHostname = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const cleanZone = zone.endsWith('.') ? zone.slice(0, -1) : zone;
  
  // If the hostname equals the zone, it's an apex domain
  return cleanHostname === cleanZone;
}

/**
 * Extract DNS configuration from container labels
 */
function extractDnsConfigFromLabels(labels, config, hostname) {
  const prefix = config.dnsLabelPrefix;
  
  // Check if this is an apex domain
  const isApex = isApexDomain(hostname, config.cloudflareZone);
  
  // Determine record type - first from specific labels, then from default
  let recordType = labels[`${prefix}type`];
  if (!recordType) {
    recordType = isApex ? 'A' : config.defaultRecordType;
  }
  
  // Get defaults for this record type
  const defaults = config.getDefaultsForType(recordType);
  
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
    if (isApex && recordType === 'CNAME') {
      // For apex domains with CNAME type, force switch to A record with IP
      recordConfig.type = 'A';
      
      // Get IP if available, otherwise set to fetch async
      const ip = config.getPublicIPSync();
      if (ip) {
        recordConfig.content = ip;
      } else {
        // We're going to need to handle this case in ensureRecord
        // Flag this record as needing async IP lookup
        recordConfig.needsIpLookup = true;
        recordConfig.content = ''; // Temporary placeholder
      }
      
      console.log(`Automatically switched ${hostname} from CNAME to A record (apex domain)`);
    } else {
      recordConfig.content = defaults.content;
    }
  } else {
    recordConfig.content = content;
  }
  
  // Handle proxied status
  if (['A', 'AAAA', 'CNAME'].includes(recordConfig.type)) {
    recordConfig.proxied = 
      labels[`${prefix}proxied`] !== undefined ? 
      labels[`${prefix}proxied`] !== 'false' : 
      defaults.proxied;
  }
  
  // Add type-specific fields
  switch (recordConfig.type) {
    case 'MX':
      recordConfig.priority = parseInt(
        labels[`${prefix}priority`] || defaults.priority, 
        10
      );
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
      break;
      
    case 'CAA':
      recordConfig.flags = parseInt(
        labels[`${prefix}flags`] || defaults.flags, 
        10
      );
      recordConfig.tag = labels[`${prefix}tag`] || defaults.tag;
      break;
  }
  
  return recordConfig;
}

module.exports = {
  extractHostnamesFromRule,
  extractDnsConfigFromLabels,
  isApexDomain
};