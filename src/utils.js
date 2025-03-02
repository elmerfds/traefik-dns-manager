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
 * Extract DNS configuration from container labels
 */
function extractDnsConfigFromLabels(labels, config, hostname) {
  const prefix = config.dnsLabelPrefix;
  
  // Determine record type - first from specific labels, then from default
  const recordType = labels[`${prefix}type`] || config.defaultRecordType;
  
  // Get defaults for this record type
  const defaults = config.getDefaultsForType(recordType);
  
  // Build basic record config
  const recordConfig = {
    type: recordType,
    name: hostname,
    ttl: parseInt(labels[`${prefix}ttl`] || defaults.ttl, 10)
  };
  
  // Handle content and proxied based on record type
  if (['A', 'AAAA', 'CNAME', 'TXT', 'NS', 'MX', 'SRV', 'CAA'].includes(recordType)) {
    recordConfig.content = labels[`${prefix}content`] || defaults.content;
  }
  
  if (['A', 'AAAA', 'CNAME'].includes(recordType)) {
    recordConfig.proxied = 
      labels[`${prefix}proxied`] !== undefined ? 
      labels[`${prefix}proxied`] !== 'false' : 
      defaults.proxied;
  }
  
  // Add type-specific fields
  switch (recordType) {
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
  extractDnsConfigFromLabels
};