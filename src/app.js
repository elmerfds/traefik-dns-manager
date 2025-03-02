/**
 * Main application entry point for Traefik DNS Manager
 * Connects to Traefik API and manages Cloudflare DNS records
 */
const CloudflareAPI = require('./cloudflare');
const TraefikAPI = require('./traefik');
const DockerAPI = require('./docker');
const ConfigManager = require('./config');
const { extractHostnamesFromRule, extractDnsConfigFromLabels } = require('./utils');

// Initialize configuration
const config = new ConfigManager();

// Initialize API clients
const cloudflare = new CloudflareAPI(config);
const traefik = new TraefikAPI(config);
const docker = new DockerAPI(config);

// Global cache for container labels
let containerLabelsCache = {};

/**
 * Main service that polls Traefik API and updates DNS records
 */
async function pollTraefikAPI() {
  try {
    console.log('Polling Traefik API for routers...');
    
    // Get all routers from Traefik
    const routers = await traefik.getRouters();
    console.log(`Found ${Object.keys(routers).length} routers in Traefik`);
    
    // Update container labels cache
    if (config.watchDockerEvents) {
      await updateContainerLabelsCache();
    }
    
    // Track processed hostnames for cleanup
    const processedHostnames = [];
    
    // Process each router
    for (const [routerName, router] of Object.entries(routers)) {
      if (router.rule && router.rule.includes('Host')) {
        // Extract all hostnames from the rule
        const hostnames = extractHostnamesFromRule(router.rule);
        
        for (const hostname of hostnames) {
          try {
            // Find container labels for this router if possible
            const containerLabels = findLabelsForRouter(router);
            
            // Check if this service should skip DNS management
            const skipDnsLabel = containerLabels[`${config.dnsLabelPrefix}skip`];
            if (skipDnsLabel === 'true') {
              console.log(`Skipping DNS management for ${hostname} due to dns.cloudflare.skip=true label`);
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
            
            // Ensure DNS record exists
            await cloudflare.ensureRecord(recordConfig);
            console.log(`Processed hostname: ${fqdn} as ${recordConfig.type} record`);
          } catch (error) {
            console.error(`Error processing hostname ${hostname}:`, error.message);
          }
        }
      }
    }
    
    // Cleanup orphaned records if configured
    if (config.cleanupOrphaned) {
      await cleanupOrphanedRecords(processedHostnames);
    }
    
  } catch (error) {
    console.error('Error polling Traefik API:', error);
  }
  
  // Schedule next poll
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
    console.log(`Updated container labels cache with ${containers.length} containers`);
  } catch (error) {
    console.error('Error updating container labels cache:', error);
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
    console.log('Checking for orphaned DNS records...');
    
    // Get all DNS records for our zone
    const allRecords = await cloudflare.listRecords();
    
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
      console.log(`Removing orphaned DNS record: ${record.name} (${record.type})`);
      await cloudflare.deleteRecord(record.id);
    }
    
    if (orphanedRecords.length > 0) {
      console.log(`Removed ${orphanedRecords.length} orphaned DNS records`);
    } else {
      console.log('No orphaned DNS records found');
    }
  } catch (error) {
    console.error('Error cleaning up orphaned records:', error);
  }
}

/**
 * Set up Docker event monitoring to trigger immediate polling
 */
async function watchDockerEvents() {
  try {
    console.log('Starting Docker event monitoring...');
    
    const events = await docker.getEvents();
    
    events.on('data', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        if (
          event.Type === 'container' && 
          ['start', 'stop', 'die', 'destroy'].includes(event.status)
        ) {
          console.log(`Docker ${event.status} event detected for ${event.Actor.Attributes.name}`);
          
          // Wait a moment for Traefik to update its routers
          setTimeout(async () => {
            await updateContainerLabelsCache();
            await pollTraefikAPI();
          }, 3000);
        }
      } catch (error) {
        console.error('Error processing Docker event:', error);
      }
    });
    
    events.on('error', (error) => {
      console.error('Docker event stream error:', error);
      // Try to reconnect after a delay
      setTimeout(watchDockerEvents, 10000);
    });
    
    console.log('Docker event monitoring started');
  } catch (error) {
    console.error('Error setting up Docker event monitoring:', error);
    // Try to reconnect after a delay
    setTimeout(watchDockerEvents, 10000);
  }
}

/**
 * Application startup
 */
async function start() {
  try {
    console.log('Starting Traefik DNS Manager...');
    console.log(`Cloudflare Zone: ${config.cloudflareZone}`);
    console.log(`Traefik API URL: ${config.traefikApiUrl}`);
    console.log(`Default DNS type: ${config.defaultRecordType}`);
    console.log(`Default DNS content: ${config.defaultContent}`);
    
    // Initialize APIs
    await cloudflare.init();
    
    // Start event monitoring if enabled
    if (config.watchDockerEvents) {
      await updateContainerLabelsCache();
      watchDockerEvents();
    }
    
    // Start initial polling
    await pollTraefikAPI();
    
    console.log('Traefik DNS Manager started successfully');
  } catch (error) {
    console.error('Failed to start Traefik DNS Manager:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  process.exit(0);
});

// Start the application
start();