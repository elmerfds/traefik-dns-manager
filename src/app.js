/**
 * Main application entry point for Traefik DNS Manager
 * Connects to Traefik API and manages Cloudflare DNS records
 */
const CloudflareAPI = require('./cloudflare');
const TraefikAPI = require('./traefik');
const DockerAPI = require('./docker');
const ConfigManager = require('./config');
const logger = require('./logger');
const { extractHostnamesFromRule, extractDnsConfigFromLabels } = require('./utils');

// Initialize configuration
const config = new ConfigManager();

// Initialize API clients
const cloudflare = new CloudflareAPI(config);
const traefik = new TraefikAPI(config);
const docker = new DockerAPI(config);

// Global cache for container labels
let containerLabelsCache = {};

// Global counters for summary statistics
global.statsCounter = {
  created: 0,
  updated: 0,
  upToDate: 0,
  errors: 0,
  total: 0
};

// Lock to prevent parallel polling
let isPolling = false;
// Track last docker event time to prevent duplicate polling
let lastDockerEventTime = 0;

/**
 * Main service that polls Traefik API and updates DNS records
 */
async function pollTraefikAPI() {
  // Skip if already polling to prevent parallel execution
  if (isPolling) {
    logger.debug('Skipping poll - another poll cycle is already in progress');
    return;
  }
  
  // Set polling lock
  isPolling = true;
  
  try {
    logger.debug('Polling Traefik API for routers...');
    
    // Reset stats counter for this polling cycle
    global.statsCounter = {
      created: 0,
      updated: 0,
      upToDate: 0,
      errors: 0,
      total: 0
    };
    
    // Get all routers from Traefik
    const routers = await traefik.getRouters();
    logger.debug(`Found ${Object.keys(routers).length} routers in Traefik`);
    
    // Update container labels cache
    if (config.watchDockerEvents) {
      await updateContainerLabelsCache();
    }
    
    // Track processed hostnames for cleanup
    const processedHostnames = [];
    
    // Collect all DNS record configurations to batch process
    const dnsRecordConfigs = [];
    
    // Count total hostnames to process
    let totalHostnames = 0;
    Object.values(routers).forEach(router => {
      if (router.rule && router.rule.includes('Host')) {
        totalHostnames += extractHostnamesFromRule(router.rule).length;
      }
    });
    
    logger.info(`Processing ${totalHostnames} hostnames for DNS management`);
    
    // Process each router to collect DNS configurations
    for (const [routerName, router] of Object.entries(routers)) {
      if (router.rule && router.rule.includes('Host')) {
        // Extract all hostnames from the rule
        const hostnames = extractHostnamesFromRule(router.rule);
        
        for (const hostname of hostnames) {
          try {
            global.statsCounter.total++;
            
            // Find container labels for this router if possible
            const containerLabels = findLabelsForRouter(router);
            
            // Check if this service should skip DNS management
            const skipDnsLabel = containerLabels[`${config.dnsLabelPrefix}skip`];
            if (skipDnsLabel === 'true') {
              logger.debug(`Skipping DNS management for ${hostname} due to dns.cloudflare.skip=true label`);
              continue; // Skip to the next hostname
            }
            
            // Create fully qualified domain name
            const fqdn = ensureFqdn(hostname, config.cloudflareZone);
            processedHostnames.push(fqdn);
            
            // Extract DNS configuration
            const recordConfig = extractDnsConfigFromLabels(
              containerLabels, 
              config,
              fqdn
            );
            
            // Add to batch instead of processing immediately
            dnsRecordConfigs.push(recordConfig);
            
          } catch (error) {
            global.statsCounter.errors++;
            logger.error(`Error processing hostname ${hostname}: ${error.message}`);
          }
        }
      }
    }
    
    // Batch process all DNS records
    if (dnsRecordConfigs.length > 0) {
      logger.debug(`Batch processing ${dnsRecordConfigs.length} DNS record configurations`);
      await cloudflare.batchEnsureRecords(dnsRecordConfigs);
    }
    
    // Log summary stats if we have records
    if (global.statsCounter.total > 0) {
      if (global.statsCounter.created > 0) {
        logger.success(`Created ${global.statsCounter.created} new DNS records`);
      }
      
      if (global.statsCounter.updated > 0) {
        logger.success(`Updated ${global.statsCounter.updated} existing DNS records`);
      }
      
      if (global.statsCounter.upToDate > 0) {
        logger.info(`${global.statsCounter.upToDate} DNS records are up to date`);
      }
      
      if (global.statsCounter.errors > 0) {
        logger.warn(`Encountered ${global.statsCounter.errors} errors processing DNS records`);
      }
    }
    
    // Cleanup orphaned records if configured
    if (config.cleanupOrphaned) {
      await cleanupOrphanedRecords(processedHostnames);
    }
    
  } catch (error) {
    logger.error(`Error polling Traefik API: ${error.message}`);
  } finally {
    // Always release the polling lock
    isPolling = false;
  }
  
  // Schedule next poll only if this is a regular poll (not triggered by Docker event)
  setTimeout(pollTraefikAPI, config.pollInterval);
}

/**
 * Update the cache of container labels
 */
async function updateContainerLabelsCache() {
  try {
    const containers = await docker.listContainers();
    const newCache = {};
    
    containers.forEach(container => {
      const id = container.Id;
      const labels = container.Labels || {};
      newCache[id] = labels;
      
      // Also index by container name for easier lookup
      if (container.Names && container.Names.length > 0) {
        const name = container.Names[0].replace(/^\//, '');
        newCache[name] = labels;
      }
    });
    
    containerLabelsCache = newCache;
    logger.debug(`Updated container labels cache with ${containers.length} containers`);
  } catch (error) {
    logger.error(`Error updating container labels cache: ${error.message}`);
  }
}

/**
 * Find labels for a router by looking at related containers
 */
function findLabelsForRouter(router) {
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
        containerLabels[`${config.traefikLabelPrefix}http.routers.${router.name}.service`] === service ||
        containerLabels[`${config.traefikLabelPrefix}http.services.${service}.loadbalancer.server.port`]
      ) {
        // Merge labels
        Object.assign(labels, containerLabels);
      }
    });
  }
  
  return labels;
}

/**
 * Ensure a hostname is a fully qualified domain name
 */
function ensureFqdn(hostname, zone) {
  if (hostname.includes('.')) {
    return hostname;
  }
  return `${hostname}.${zone}`;
}

/**
 * Clean up orphaned DNS records
 */
async function cleanupOrphanedRecords(activeHostnames) {
  try {
    logger.debug('Checking for orphaned DNS records...');
    
    // Get all DNS records for our zone (from cache when possible)
    const allRecords = await cloudflare.getRecordsFromCache();
    
    // Find records that were created by this tool but no longer exist in Traefik
    const orphanedRecords = allRecords.filter(record => {
      // Skip records that aren't managed by this tool
      if (record.comment !== 'Managed by Traefik DNS Manager') {
        return false;
      }
      
      // Check if this record is still active
      return !activeHostnames.includes(record.name);
    });
    
    // Delete orphaned records
    for (const record of orphanedRecords) {
      logger.debug(`Removing orphaned DNS record: ${record.name} (${record.type})`);
      await cloudflare.deleteRecord(record.id);
    }
    
    if (orphanedRecords.length > 0) {
      logger.success(`Removed ${orphanedRecords.length} orphaned DNS records`);
    } else {
      logger.success('No orphaned DNS records found');
    }
  } catch (error) {
    logger.error(`Error cleaning up orphaned records: ${error.message}`);
  }
}

/**
 * Set up Docker event monitoring to trigger immediate polling
 */
async function watchDockerEvents() {
  try {
    logger.debug('Starting Docker event monitoring...');
    
    const events = await docker.getEvents();
    
    events.on('data', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        if (
          event.Type === 'container' && 
          ['start', 'stop', 'die', 'destroy'].includes(event.status)
        ) {
          logger.debug(`Docker ${event.status} event detected for ${event.Actor.Attributes.name}`);
          
          // Prevent too frequent updates by checking time since last event
          const now = Date.now();
          if (now - lastDockerEventTime < 3000) {
            logger.debug('Skipping Docker event polling (rate limiting)');
            return;
          }
          
          lastDockerEventTime = now;
          
          // Wait a moment for Traefik to update its routers
          setTimeout(async () => {
            // Only trigger polling if not already polling
            if (!isPolling) {
              await updateContainerLabelsCache();
              await pollTraefikAPI();
            } else {
              logger.debug('Skipping Docker event polling (already polling)');
            }
          }, 3000);
        }
      } catch (error) {
        logger.error(`Error processing Docker event: ${error.message}`);
      }
    });
    
    events.on('error', (error) => {
      logger.error(`Docker event stream error: ${error.message}`);
      // Try to reconnect after a delay
      setTimeout(watchDockerEvents, 10000);
    });
    
    logger.debug('Docker event monitoring started');
  } catch (error) {
    logger.error(`Error setting up Docker event monitoring: ${error.message}`);
    // Try to reconnect after a delay
    setTimeout(watchDockerEvents, 10000);
  }
}

/**
 * Application startup
 */
async function start() {
  try {
    logger.success('Starting Traefik DNS Manager');
    logger.info(`Cloudflare Zone: ${config.cloudflareZone}`);
    logger.debug(`Traefik API URL: ${config.traefikApiUrl}`);
    logger.debug(`Default DNS type: ${config.defaultRecordType}`);
    logger.debug(`Default DNS content: ${config.defaultContent}`);
    
    // Initialize APIs
    await cloudflare.init();
    
    // Ensure we have a public IP before proceeding
    logger.debug('Detecting public IP address...');
    await config.updatePublicIPs();
    
    // Verify that we have an IP for A records
    if (!config.getPublicIPSync()) {
      logger.warn('Could not detect public IP address. A records for apex domains will fail.');
      logger.warn('Consider setting PUBLIC_IP environment variable manually.');
    } else {
      logger.debug(`Using public IP: ${config.getPublicIPSync()}`);
    }
    
    // Start event monitoring if enabled
    if (config.watchDockerEvents) {
      await updateContainerLabelsCache();
      watchDockerEvents();
    }
    
    // Start initial polling
    await pollTraefikAPI();
    
    logger.complete('Traefik DNS Manager running successfully');
  } catch (error) {
    logger.error(`Failed to start Traefik DNS Manager: ${error.message}`);
    process.exit(1);
  }
}

// Start the application
start();