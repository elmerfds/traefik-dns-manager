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
      
      // For tracking changes - use a Map to associate container IDs with their names
      const previousContainers = new Set(Object.keys(this.containerLabelsCache));
      const currentContainers = new Set();
      const containerNameToId = new Map();
      const dnsLabelChanges = {};
      
      containers.forEach(container => {
        const id = container.Id;
        const labels = container.Labels || {};
        newCache[id] = labels;
        currentContainers.add(id);
        
        // Also index by container name for easier lookup
        if (container.Names && container.Names.length > 0) {
          const name = container.Names[0].replace(/^\//, '');
          newCache[name] = labels;
          currentContainers.add(name);
          containerNameToId.set(name, id); // Track which ID belongs to which name
          
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
          } else if (Object.keys(dnsLabels).length > 0) {
            // No changes but still has DNS labels - log at debug level
            logger.debug(`Container ${name} has DNS labels: ${JSON.stringify(dnsLabels)} (unchanged)`);
          }
        }
      });
      
      // Check for removed containers with DNS labels
      const removedContainers = Array.from(previousContainers).filter(id => !currentContainers.has(id));
      for (const id of removedContainers) {
        const prevLabels = this.containerLabelsCache[id];
        const hasDnsLabels = Object.keys(prevLabels || {}).some(key => key.startsWith(dnsLabelPrefix));
        
        if (hasDnsLabels) {
          // Use a friendly name if available, otherwise the ID
          const isName = !id.includes(':'); // Simple heuristic to distinguish names from IDs
          logger.info(`Container ${id} with DNS labels was removed`);
          dnsLabelChanges[id] = true;
        }
      }
      
      // Log a summary of changes if any occurred - using only container names when possible
      const changeCount = Object.keys(dnsLabelChanges).length;
      if (changeCount > 0) {
        // Filter out duplicate entries (IDs that have a corresponding name)
        const changedNames = Object.keys(dnsLabelChanges).filter(key => {
          // If it's a container ID and we have a name for it, filter it out
          const isId = key.length > 12 && /^[0-9a-f]+$/.test(key);
          if (isId) {
            // Check if this ID has a corresponding name in our changes
            for (const [name, id] of containerNameToId.entries()) {
              if (id === key && dnsLabelChanges[name]) {
                return false; // Filter out this ID since we have the name
              }
            }
          }
          return true;
        });
        
        logger.info(`DNS label changes detected on ${changedNames.length} containers: ${changedNames.join(', ')}`);
      }
      
      this.containerLabelsCache = newCache;
      logger.debug(`Updated container labels cache with ${containers.length} containers`);
      
      // Publish an immediate event with the updated labels
      this.eventBus.publish(EventTypes.DOCKER_LABELS_UPDATED, {
        containerLabelsCache: this.containerLabelsCache,
        triggerSource: 'updateContainerLabelsCache',
        hasChanges: changeCount > 0
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