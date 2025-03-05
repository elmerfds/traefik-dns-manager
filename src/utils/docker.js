/**
 * Docker-related utility functions
 */
const logger = require('./logger');

/**
 * Extract container name from Docker container
 * @param {Object} container - Docker container object
 * @returns {string} - Container name without leading slash
 */
function getContainerName(container) {
  if (!container || !container.Names || !container.Names.length) {
    return 'unknown';
  }
  
  // Remove leading slash
  return container.Names[0].replace(/^\//, '');
}

/**
 * Extract relevant labels from container
 * @param {Object} container - Docker container object
 * @param {string} prefix - Label prefix to filter by (optional)
 * @returns {Object} - Object with filtered labels
 */
function extractLabels(container, prefix = null) {
  if (!container || !container.Labels) {
    return {};
  }
  
  const labels = container.Labels;
  
  // If no prefix, return all labels
  if (!prefix) {
    return { ...labels };
  }
  
  // Filter labels by prefix
  return Object.entries(labels)
    .filter(([key]) => key.startsWith(prefix))
    .reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
}

/**
 * Check if a container is managed by Docker Compose
 * @param {Object} container - Docker container object
 * @returns {boolean} - True if container is managed by Docker Compose
 */
function isComposeManaged(container) {
  if (!container || !container.Labels) {
    return false;
  }
  
  // Check for Docker Compose labels
  return 'com.docker.compose.project' in container.Labels;
}

/**
 * Get Docker Compose project name for a container
 * @param {Object} container - Docker container object
 * @returns {string|null} - Project name or null if not found
 */
function getComposeProject(container) {
  if (!isComposeManaged(container)) {
    return null;
  }
  
  return container.Labels['com.docker.compose.project'];
}

/**
 * Get Docker Compose service name for a container
 * @param {Object} container - Docker container object
 * @returns {string|null} - Service name or null if not found
 */
function getComposeService(container) {
  if (!isComposeManaged(container)) {
    return null;
  }
  
  return container.Labels['com.docker.compose.service'];
}

module.exports = {
  getContainerName,
  extractLabels,
  isComposeManaged,
  getComposeProject,
  getComposeService
};