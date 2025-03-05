/**
 * DNS Manager Service
 * Responsible for managing DNS records through the selected provider
 */
const { DNSProviderFactory } = require('../providers');
const logger = require('../utils/logger');
const EventTypes = require('../events/EventTypes');
const { extractDnsConfigFromLabels } = require('../utils/dns');

class DNSManager {
  constructor(config, eventBus) {
    this.config = config;
    this.eventBus = eventBus;
    this.dnsProvider = DNSProviderFactory.createProvider(config);
    
    // Initialize counters for statistics
    this.stats = {
      created: 0,
      updated: 0,
      upToDate: 0,
      errors: 0,
      total: 0
    };
    
    // Track previous poll statistics to reduce logging noise
    this.previousStats = {
      upToDateCount: 0
    };
    
    // Subscribe to relevant events
    this.setupEventSubscriptions();
  }
  
  /**
   * Initialize the DNS Manager
   */
  async init() {
    try {
      logger.debug('Initializing DNS Manager...');
      await this.dnsProvider.init();
      logger.success('DNS Manager initialized successfully');
      return true;
    } catch (error) {
      logger.error(`Failed to initialize DNS Manager: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Set up event subscriptions
   */
  setupEventSubscriptions() {
    // Subscribe to Traefik router updates
    this.eventBus.subscribe(EventTypes.TRAEFIK_ROUTERS_UPDATED, async (data) => {
      const { hostnames, containerLabels } = data;
      await this.processHostnames(hostnames, containerLabels);
    });
  }
  
  /**
   * Process a list of hostnames and ensure DNS records exist
   * @param {Array<string>} hostnames - List of hostnames to process
   * @param {Object} containerLabels - Map of container IDs to their labels
   */
  async processHostnames(hostnames, containerLabels) {
    try {
      logger.debug(`DNS Manager processing ${hostnames.length} hostnames`);
      
      // Reset statistics for this processing run
      this.resetStats();
      
      // Track processed hostnames for cleanup
      const processedHostnames = [];
      
      // Collect all DNS record configurations to batch process
      const dnsRecordConfigs = [];
      
      // Process each hostname
      for (const hostname of hostnames) {
        try {
          this.stats.total++;
          
          // Find container labels for this hostname if possible
          const labels = containerLabels[hostname] || {};
          
          // Check if we should manage DNS based on global setting and labels
          const labelPrefix = this.config.dnsLabelPrefix;
          const manageLabel = labels[`${labelPrefix}manage`];
          const skipLabel = labels[`${labelPrefix}skip`];
          
          // Determine whether to manage this hostname's DNS
          let shouldManage = this.config.defaultManage;
          
          // If global setting is false (opt-in), check for explicit manage=true
          if (!shouldManage && manageLabel === 'true') {
            shouldManage = true;
            logger.debug(`Enabling DNS management for ${hostname} due to ${labelPrefix}manage=true label`);
          }
          
          // Skip label always overrides (for backward compatibility)
          if (skipLabel === 'true') {
            shouldManage = false;
            logger.debug(`Skipping DNS management for ${hostname} due to ${labelPrefix}skip=true label`);
          }
          
          // Skip to next hostname if we shouldn't manage this one
          if (!shouldManage) {
            continue;
          }
          
          // Create fully qualified domain name
          const fqdn = this.ensureFqdn(hostname, this.config.getProviderDomain());
          processedHostnames.push(fqdn);
          
          // Extract DNS configuration
          const recordConfig = extractDnsConfigFromLabels(
            labels, 
            this.config,
            fqdn
          );
          
          // Add to batch instead of processing immediately
          dnsRecordConfigs.push(recordConfig);
          
        } catch (error) {
          this.stats.errors++;
          logger.error(`Error processing hostname ${hostname}: ${error.message}`);
        }
      }
      
      // Batch process all DNS records
      if (dnsRecordConfigs.length > 0) {
        logger.debug(`Batch processing ${dnsRecordConfigs.length} DNS record configurations`);
        await this.dnsProvider.batchEnsureRecords(dnsRecordConfigs);
      }
      
      // Log summary stats if we have records
      this.logStats();
      
      // Cleanup orphaned records if configured
      if (this.config.cleanupOrphaned && processedHostnames.length > 0) {
        await this.cleanupOrphanedRecords(processedHostnames);
      }
      
      // Publish event with results
      this.eventBus.publish(EventTypes.DNS_RECORDS_UPDATED, {
        stats: this.stats,
        processedHostnames
      });
      
      return {
        stats: this.stats,
        processedHostnames
      };
    } catch (error) {
      logger.error(`Error processing hostnames: ${error.message}`);
      this.eventBus.publish(EventTypes.ERROR_OCCURRED, {
        source: 'DNSManager.processHostnames',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Reset statistics counters
   */
  resetStats() {
    this.stats = {
      created: 0,
      updated: 0,
      upToDate: 0,
      errors: 0,
      total: 0
    };
  }
  
  /**
   * Log statistics about processed DNS records
   */
  logStats() {
    if (this.stats.total > 0) {
      if (this.stats.created > 0) {
        logger.success(`Created ${this.stats.created} new DNS records`);
        
        // Publish event for each creation (for metrics/monitoring)
        this.eventBus.publish(EventTypes.DNS_RECORD_CREATED, {
          count: this.stats.created
        });
      }
      
      if (this.stats.updated > 0) {
        logger.success(`Updated ${this.stats.updated} existing DNS records`);
        
        // Publish event for each update
        this.eventBus.publish(EventTypes.DNS_RECORD_UPDATED, {
          count: this.stats.updated
        });
      }
      
      // Only log "up to date" records if the count has changed
      if (this.stats.upToDate > 0) {
        const hasUpToDateChanged = this.previousStats.upToDateCount !== this.stats.upToDate;
        
        if (hasUpToDateChanged) {
          logger.info(`${this.stats.upToDate} DNS records are up to date`);
        } else {
          // Log at debug level instead of info when nothing has changed
          logger.debug(`${this.stats.upToDate} DNS records are up to date`);
        }
        
        // Update for next comparison
        this.previousStats.upToDateCount = this.stats.upToDate;
      }
      
      if (this.stats.errors > 0) {
        logger.warn(`Encountered ${this.stats.errors} errors processing DNS records`);
      }
    }
  }
  
  /**
   * Ensure a hostname is a fully qualified domain name
   */
  ensureFqdn(hostname, zone) {
    if (hostname.includes('.')) {
      return hostname;
    }
    return `${hostname}.${zone}`;
  }
  
  /**
   * Clean up orphaned DNS records
   */
  async cleanupOrphanedRecords(activeHostnames) {
    try {
      logger.debug('Checking for orphaned DNS records...');
      
      // Get all DNS records for our zone (from cache when possible)
      const allRecords = await this.dnsProvider.getRecordsFromCache();
      
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
        // Log at INFO level which records are being removed
        logger.info(`🗑️ Removing orphaned DNS record: ${record.name} (${record.type})`);
        await this.dnsProvider.deleteRecord(record.id);
        
        // Publish delete event
        this.eventBus.publish(EventTypes.DNS_RECORD_DELETED, {
          name: record.name,
          type: record.type
        });
      }
      
      if (orphanedRecords.length > 0) {
        logger.success(`Removed ${orphanedRecords.length} orphaned DNS records`);
      } else {
        logger.debug('No orphaned DNS records found');
      }
    } catch (error) {
      logger.error(`Error cleaning up orphaned records: ${error.message}`);
      this.eventBus.publish(EventTypes.ERROR_OCCURRED, {
        source: 'DNSManager.cleanupOrphanedRecords',
        error: error.message
      });
    }
  }
}

module.exports = DNSManager;