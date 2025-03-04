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
   * Update the cache of container labels
   */
  async updateContainerLabelsCache() {
    try {
      const containers = await this.listContainers();
      const newCache = {};
      const dnsLabelPrefix = this.config.dnsLabelPrefix;
      
      containers.forEach(container => {
        const id = container.Id;
        const labels = container.Labels || {};
        newCache[id] = labels;
        
        // Also index by container name for easier lookup
        if (container.Names && container.Names.length > 0) {
          const name = container.Names[0].replace(/^\//, '');
          newCache[name] = labels;
          
          // Check for DNS-specific labels and log them for debugging
          const dnsLabels = {};
          for (const [key, value] of Object.entries(labels)) {
            if (key.startsWith(dnsLabelPrefix)) {
              dnsLabels[key] = value;
            }
          }
          
          if (Object.keys(dnsLabels).length > 0) {
            logger.info(`Container ${name} has DNS labels: ${JSON.stringify(dnsLabels)}`);
            
            // If container has a proxied=false label, log it prominently
            if (dnsLabels[`${dnsLabelPrefix}proxied`] === 'false') {
              logger.info(`⚠️ Container ${name} has proxied=false label - will disable Cloudflare proxy`);
            }
          }
        }
      });
      
      this.containerLabelsCache = newCache;
      logger.debug(`Updated container labels cache with ${containers.length} containers`);
      
      // Publish an immediate event with the updated labels
      this.eventBus.publish(EventTypes.DOCKER_LABELS_UPDATED, {
        containerLabelsCache: this.containerLabelsCache,
        triggerSource: 'updateContainerLabelsCache'
      });
      
      return this.containerLabelsCache;
    } catch (error) {
      logger.error(`Error updating container labels cache: ${error.message}`);
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