/**
 * Docker Monitor Service
 * Responsible for monitoring Docker container events
 */
const Docker = require('dockerode');
const logger = require('../utils/logger');
const EventTypes = require('../events/EventTypes');

class DockerMonitor {
  constructor(config, eventBus) {
    this.config = config;
    this.eventBus = eventBus;
    
    // Initialize Docker client
    this.docker = new Docker({
      socketPath: config.dockerSocket
    });
    
    // Track last event time to prevent duplicate polling
    this.lastEventTime = 0;
    
    // Global cache for container labels
    this.containerLabelsCache = {};
    
    // Event stream reference
    this.events = null;
  }
  
  /**
   * Start watching Docker events
   */
  async startWatching() {
    try {
      // First, update container labels cache
      await this.updateContainerLabelsCache();
      
      logger.debug('Starting Docker event monitoring...');
      
      // Get the event stream
      this.events = await this.getEvents();
      
      // Set up event listeners
      this.setupEventListeners();
      
      logger.success('Docker event monitoring started successfully');
      return true;
    } catch (error) {
      logger.error(`Failed to start Docker monitoring: ${error.message}`);
      
      // Try to reconnect after a delay
      setTimeout(() => this.startWatching(), 10000);
      
      throw error;
    }
  }
  
  /**
   * Stop watching Docker events
   */
  stopWatching() {
    if (this.events) {
      try {
        this.events.destroy();
        this.events = null;
        logger.debug('Docker event monitoring stopped');
      } catch (error) {
        logger.error(`Error stopping Docker event monitoring: ${error.message}`);
      }
    }
  }
  
  /**
   * Set up event listeners for Docker events
   */
  setupEventListeners() {
    if (!this.events) return;
    
    this.events.on('data', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        if (
          event.Type === 'container' && 
          ['start', 'stop', 'die', 'destroy'].includes(event.status)
        ) {
          const containerName = event.Actor.Attributes.name || 'unknown';
          logger.debug(`Docker ${event.status} event detected for ${containerName}`);
          
          // Publish Docker event
          this.eventBus.publish(
            event.status === 'start' 
              ? EventTypes.DOCKER_CONTAINER_STARTED 
              : EventTypes.DOCKER_CONTAINER_STOPPED,
            {
              containerId: event.Actor.ID,
              containerName,
              status: event.status
            }
          );
          
          // Prevent too frequent updates by checking time since last event
          const now = Date.now();
          if (now - this.lastEventTime < 3000) {
            logger.debug('Skipping Docker event processing (rate limiting)');
            return;
          }
          
          this.lastEventTime = now;
          
          // Wait a moment for Traefik to update its routers
          setTimeout(async () => {
            // Update container labels cache
            await this.updateContainerLabelsCache();
            
            // Publish labels updated event
            this.eventBus.publish(EventTypes.DOCKER_LABELS_UPDATED, {
              containerLabelsCache: this.containerLabelsCache,
              triggerContainer: containerName
            });
          }, 3000);
        }
      } catch (error) {
        logger.error(`Error processing Docker event: ${error.message}`);
      }
    });
    
    this.events.on('error', (error) => {
      logger.error(`Docker event stream error: ${error.message}`);
      
      // Try to reconnect after a delay
      this.stopWatching();
      setTimeout(() => this.startWatching(), 10000);
    });
    
    logger.debug('Docker event listeners set up');
  }
  
  /**
   * Update the cache of container labels
   */
  async updateContainerLabelsCache() {
    try {
      const containers = await this.listContainers();
      const newCache = {};
      const dnsLabelPrefix = this.config.dnsLabelPrefix;
      
      // For tracking changes - track IDs, names, and their relationships
      const containerIdToName = new Map();  // Map container IDs to names
      const containerNameToId = new Map();  // Map container names to IDs
      const previousIds = new Set();        // Track previous container IDs
      const previousNames = new Set();      // Track previous container names
      const currentIds = new Set();         // Track current container IDs
      const currentNames = new Set();       // Track current container names
      const dnsLabelChanges = {};           // Track which containers had changes
      
      // Build maps of previous container relationships
      for (const [key, labels] of Object.entries(this.containerLabelsCache)) {
        // If key looks like a container ID (long hex string)
        if (key.length > 12 && /^[0-9a-f]+$/.test(key)) {
          previousIds.add(key);
        } else {
          // Otherwise assume it's a container name
          previousNames.add(key);
        }
      }
      
      // Process current containers
      containers.forEach(container => {
        const id = container.Id;
        const labels = container.Labels || {};
        currentIds.add(id);
        newCache[id] = labels;
        
        // Also index by container name for easier lookup
        if (container.Names && container.Names.length > 0) {
          const name = container.Names[0].replace(/^\//, '');
          currentNames.add(name);
          newCache[name] = labels;
          
          // Track container ID to name and vice versa
          containerIdToName.set(id, name);
          containerNameToId.set(name, id);
          
          // Check for DNS-specific labels and log them for debugging
          const dnsLabels = {};
          for (const [key, value] of Object.entries(labels)) {
            if (key.startsWith(dnsLabelPrefix)) {
              dnsLabels[key] = value;
            }
          }
          
          // Compare with previous labels to detect changes
          const hasPreviousLabels = this.containerLabelsCache[name];
          let dnsLabelsChanged = false;
          
          if (hasPreviousLabels) {
            const prevLabels = this.containerLabelsCache[name];
            
            // Check if any DNS labels changed
            for (const [key, value] of Object.entries(dnsLabels)) {
              if (prevLabels[key] !== value) {
                dnsLabelsChanged = true;
                dnsLabelChanges[name] = true;
                break;
              }
            }
            
            // Check if any DNS labels were removed
            for (const key of Object.keys(prevLabels)) {
              if (key.startsWith(dnsLabelPrefix) && dnsLabels[key] === undefined) {
                dnsLabelsChanged = true;
                dnsLabelChanges[name] = true;
                break;
              }
            }
          } else {
            // New container with DNS labels
            if (Object.keys(dnsLabels).length > 0) {
              dnsLabelsChanged = true;
              dnsLabelChanges[name] = true;
            }
          }
          
          // Only log at INFO level if there are changes or new containers
          if (dnsLabelsChanged && Object.keys(dnsLabels).length > 0) {
            logger.info(`Container ${name} has DNS labels: ${JSON.stringify(dnsLabels)}`);
            
            // If container has a proxied=false label, log it prominently
            if (dnsLabels[`${dnsLabelPrefix}proxied`] === 'false') {
              logger.info(`⚠️ Container ${name} has proxied=false label - will disable Cloudflare proxy`);
            }
            
            // If container has skip=true label, log it prominently
            if (dnsLabels[`${dnsLabelPrefix}skip`] === 'true') {
              logger.info(`⚠️ Container ${name} has skip=true label - will skip DNS management`);
            }
          } else if (Object.keys(dnsLabels).length > 0) {
            // No changes but still has DNS labels - log at debug level
            logger.debug(`Container ${name} has DNS labels: ${JSON.stringify(dnsLabels)} (unchanged)`);
          }
        }
      });
      
      // Check for removed containers with DNS labels
      // First check removed IDs
      const removedIds = new Set([...previousIds].filter(id => !currentIds.has(id)));
      
      for (const id of removedIds) {
        const prevLabels = this.containerLabelsCache[id];
        const hasDnsLabels = prevLabels && Object.keys(prevLabels).some(key => key.startsWith(dnsLabelPrefix));
        
        if (hasDnsLabels) {
          logger.info(`Container ${id} with DNS labels was removed`);
          // Only add to changes if we don't already have a matching name
          const name = [...previousNames].find(name => 
            this.containerLabelsCache[name] === prevLabels
          );
          
          if (!name || !dnsLabelChanges[name]) {
            dnsLabelChanges[id] = true;
          }
        }
      }
      
      // Then check removed names
      const removedNames = new Set([...previousNames].filter(name => !currentNames.has(name)));
      
      for (const name of removedNames) {
        const prevLabels = this.containerLabelsCache[name];
        const hasDnsLabels = prevLabels && Object.keys(prevLabels).some(key => key.startsWith(dnsLabelPrefix));
        
        if (hasDnsLabels) {
          logger.info(`Container ${name} with DNS labels was removed`);
          dnsLabelChanges[name] = true;
        }
      }
      
      // Log a summary of changes if any occurred - using only container names when possible
      const changedItems = Object.keys(dnsLabelChanges);
      
      if (changedItems.length > 0) {
        // Deduplicate changes - prefer names over IDs
        const uniqueChanges = new Set();
        
        for (const item of changedItems) {
          // If it looks like a container ID
          if (item.length > 12 && /^[0-9a-f]+$/.test(item)) {
            // Check if we have a name for this ID
            const name = containerIdToName.get(item);
            if (name && dnsLabelChanges[name]) {
              // Skip the ID since we have the name
              continue;
            }
          }
          // Add this change (either a name or an ID without a matching name)
          uniqueChanges.add(item);
        }
        
        const uniqueChangesArray = [...uniqueChanges];
        logger.info(`DNS label changes detected on ${uniqueChangesArray.length} containers: ${uniqueChangesArray.join(', ')}`);
      }
      
      this.containerLabelsCache = newCache;
      logger.debug(`Updated container labels cache with ${containers.length} containers`);
      
      // Publish an immediate event with the updated labels
      this.eventBus.publish(EventTypes.DOCKER_LABELS_UPDATED, {
        containerLabelsCache: this.containerLabelsCache,
        triggerSource: 'updateContainerLabelsCache',
        hasChanges: changedItems.length > 0
      });
      
      return this.containerLabelsCache;
    } catch (error) {
      logger.error(`Error updating container labels cache: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get Docker events stream
   */
  async getEvents(filters = { type: ['container'] }) {
    try {
      return await this.docker.getEvents({
        filters
      });
    } catch (error) {
      logger.error(`Failed to get Docker events: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * List all running containers
   */
  async listContainers() {
    try {
      return await this.docker.listContainers({
        all: false // Only running containers
      });
    } catch (error) {
      logger.error(`Failed to list containers: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get container details by ID
   */
  async getContainer(id) {
    try {
      const container = this.docker.getContainer(id);
      const details = await container.inspect();
      return details;
    } catch (error) {
      logger.error(`Failed to get container ${id}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get the current container labels cache
   */
  getContainerLabelsCache() {
    return this.containerLabelsCache;
  }
  
  /**
   * Test the connection to the Docker socket
   */
  async testConnection() {
    try {
      const info = await this.docker.info();
      return true;
    } catch (error) {
      logger.error(`Failed to connect to Docker: ${error.message}`);
      return false;
    }
  }
}

module.exports = DockerMonitor;