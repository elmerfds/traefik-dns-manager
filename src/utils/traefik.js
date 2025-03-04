/**
 * Traefik-related utility functions
 */
const logger = require('./logger');

/**
 * Extract hostnames from a Traefik router rule
 * Supports both v1 and v2 formats
 * @param {string} rule - Traefik router rule
 * @returns {Array<string>} - Array of extracted hostnames
 */
function extractHostnamesFromRule(rule) {
  logger.trace(`traefik.extractHostnamesFromRule: Extracting hostnames from rule: ${rule}`);
  
  const hostnames = [];
  
  // Handle Traefik v2 format: Host(`example.com`)
  const v2HostRegex = /Host\(`([^`]+)`\)/g;
  let match;
  
  while ((match = v2HostRegex.exec(rule)) !== null) {
    logger.trace(`traefik.extractHostnamesFromRule: Found v2 hostname: ${match[1]}`);
    hostnames.push(match[1]);
  }
  
  // Handle Traefik v1 format: Host:example.com
  const v1HostRegex = /Host:([a-zA-Z0-9.-]+)/g;
  
  while ((match = v1HostRegex.exec(rule)) !== null) {
    logger.trace(`traefik.extractHostnamesFromRule: Found v1 hostname: ${match[1]}`);
    hostnames.push(match[1]);
  }
  
  logger.trace(`traefik.extractHostnamesFromRule: Extracted ${hostnames.length} hostnames: ${hostnames.join(', ')}`);
  return hostnames;
}

/**
 * Find labels for a router by looking at container label cache
 * @param {Object} router - Traefik router object
 * @param {Object} containerLabelsCache - Cache of container labels
 * @param {string} traefikLabelPrefix - Prefix for Traefik labels
 * @returns {Object} - Labels for the router
 */
function findLabelsForRouter(router, containerLabelsCache, traefikLabelPrefix) {
  // Start with empty labels
  const labels = {};
  
  // Check if router has a related container
  const service = router.service;
  if (service) {
    // Try to find container by service name
    Object.entries(containerLabelsCache).forEach(([key, containerLabels]) => {
      // Various ways a container might be related to this router
      if (
        key === service || 
        containerLabels[`${traefikLabelPrefix}http.routers.${router.name}.service`] === service ||
        containerLabels[`${traefikLabelPrefix}http.services.${service}.loadbalancer.server.port`]
      ) {
        // Merge labels
        Object.assign(labels, containerLabels);
      }
    });
  }
  
  return labels;
}

/**
 * Parse and extract service name from router
 * @param {Object} router - Traefik router object
 * @returns {string|null} - Service name or null if not found
 */
function extractServiceName(router) {
  if (!router || !router.service) {
    return null;
  }
  
  return router.service;
}

module.exports = {
  extractHostnamesFromRule,
  findLabelsForRouter,
  extractServiceName
};