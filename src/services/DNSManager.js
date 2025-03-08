/**
 * DNS Manager Service
 * Responsible for managing DNS records through the selected provider
 */
const { DNSProviderFactory } = require('../providers');
const logger = require('../utils/logger');
const EventTypes = require('../events/EventTypes');
const { extractDnsConfigFromLabels } = require('../utils/dns');
const RecordTracker = require('../utils/recordTracker');

class DNSManager {
  constructor(config, eventBus) {
    this.config = config;
    this.eventBus = eventBus;
    this.dnsProvider = DNSProviderFactory.createProvider(config);
    
    // Initialize record tracker
    this.recordTracker = new RecordTracker(config);
    
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
          
          // Get label prefixes for easier reference
          const genericLabelPrefix = this.config.genericLabelPrefix;
          const providerLabelPrefix = this.config.dnsLabelPrefix;
          
          // Check if we should manage DNS based on global setting and labels
          // First check generic labels
          let manageLabel = labels[`${genericLabelPrefix}manage`];
          let skipLabel = labels[`${genericLabelPrefix}skip`];
          
          // Then check provider-specific labels which take precedence
          if (labels[`${providerLabelPrefix}manage`] !== undefined) {
            manageLabel = labels[`${providerLabelPrefix}manage`];
            logger.debug(`Found provider-specific manage label: ${providerLabelPrefix}manage=${manageLabel}`);
          }
          
          if (labels[`${providerLabelPrefix}skip`] !== undefined) {
            skipLabel = labels[`${providerLabelPrefix}skip`];
            logger.debug(`Found provider-specific skip label: ${providerLabelPrefix}skip=${skipLabel}`);
          }
          
          // Determine whether to manage this hostname's DNS
          let shouldManage = this.config.defaultManage;
          
          // If global setting is false (opt-in), check for explicit manage=true
          if (!shouldManage && manageLabel === 'true') {
            shouldManage = true;
            logger.debug(`Enabling DNS management for ${hostname} due to manage=true label`);
          }
          
          // Skip label always overrides (for backward compatibility)
          if (skipLabel === 'true') {
            shouldManage = false;
            logger.debug(`Skipping DNS management for ${hostname} due to skip=true label`);
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
        const processedRecords = await this.dnsProvider.batchEnsureRecords(dnsRecordConfigs);
        
        // Track all created/updated records
        if (processedRecords && processedRecords.length > 0) {
          for (const record of processedRecords) {
            // Only track records that have an ID (successfully created/updated)
            if (record && record.id) {
              // Check if this is a new record or just an update
              const isTracked = this.recordTracker.isTracked(record);
              
              if (isTracked) {
                // Update the tracked record with the latest ID
                this.recordTracker.updateRecordId(record, record);
              } else {
                // Track new record
                this.recordTracker.trackRecord(record);
              }
            }
          }
        }
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
      const allRecords = await this.dnsProvider.getRecordsFromCache(true); // Force refresh
      
      // Normalize active hostnames for comparison
      const normalizedActiveHostnames = new Set(activeHostnames.map(host => host.toLowerCase()));
      
      // Log all active hostnames in trace mode
      logger.trace(`Active hostnames: ${Array.from(normalizedActiveHostnames).join(', ')}`);
      
      // Find records that were created by this tool but no longer exist in Traefik
      const orphanedRecords = [];
      const domainSuffix = `.${this.config.getProviderDomain()}`;
      const domainName = this.config.getProviderDomain().toLowerCase();
      
      for (const record of allRecords) {
        // Skip apex domain/root records
        if (record.name === '@' || record.name === this.config.getProviderDomain()) {
          logger.debug(`Skipping apex record: ${record.name}`);
          continue;
        }
        
        // Skip records that aren't a subdomain of our managed domain
        if (record.type === 'NS' || record.type === 'SOA' || record.type === 'CAA') {
          logger.debug(`Skipping system record: ${record.name} (${record.type})`);
          continue;
        }
        
        // Check if this record is tracked by our tool
        if (!this.recordTracker.isTracked(record)) {
          // Support legacy records with comment for backward compatibility
          if (this.config.dnsProvider === 'cloudflare' && record.comment === 'Managed by Traefik DNS Manager') {
            // This is a legacy record created before we implemented tracking
            // Add it to our tracker for future reference
            logger.debug(`Found legacy managed record with comment: ${record.name} (${record.type})`);
            this.recordTracker.trackRecord(record);
          } else {
            // Not tracked and not a legacy record - skip it
            logger.debug(`Skipping non-managed record: ${record.name} (${record.type})`);
            continue;
          }
        }
        
        // Reconstruct the FQDN from record name format
        let recordFqdn;
        if (record.name === '@') {
          recordFqdn = domainName;
        } else {
          // Check if the record name already contains the domain
          const recordName = record.name.toLowerCase();
          if (recordName.endsWith(domainName)) {
            // Already has domain name, use as is
            recordFqdn = recordName;
          } else {
            // Need to append domain
            recordFqdn = `${recordName}${domainSuffix}`;
          }
        }
        
        // Check for domain duplication (e.g., example.com.example.com)
        const doublePattern = new RegExp(`${domainName}\\.${domainName}$`, 'i');
        if (doublePattern.test(recordFqdn)) {
          // Remove the duplicated domain part
          recordFqdn = recordFqdn.replace(doublePattern, domainName);
          logger.debug(`Fixed duplicated domain in record: ${recordFqdn}`);
        }
        
        // Log each record for debugging
        logger.debug(`Checking record FQDN: ${recordFqdn} (${record.type})`);
        
        // Check if this record should be preserved
        if (this.recordTracker.shouldPreserveHostname(recordFqdn)) {
          logger.info(`Preserving DNS record (in preserved list): ${recordFqdn} (${record.type})`);
          continue;
        }
        
        // Check if this record is still active
        if (!normalizedActiveHostnames.has(recordFqdn)) {
          logger.debug(`Found orphaned record: ${recordFqdn} (${record.type})`);
          orphanedRecords.push({
            ...record,
            displayName: recordFqdn // Save the normalized display name
          });
        }
      }
      
      // Delete orphaned records
      if (orphanedRecords.length > 0) {
        logger.info(`Found ${orphanedRecords.length} orphaned DNS records to clean up`);
        
        for (const record of orphanedRecords) {
          // Use the saved display name for logging
          const displayName = record.displayName || 
                             (record.name === '@' ? this.config.getProviderDomain() 
                                                 : `${record.name}.${this.config.getProviderDomain()}`);
                             
          logger.info(`🗑️ Removing orphaned DNS record: ${displayName} (${record.type})`);
          
          try {
            await this.dnsProvider.deleteRecord(record.id);
            
            // Remove record from tracker
            this.recordTracker.untrackRecord(record);
            
            // Publish delete event
            this.eventBus.publish(EventTypes.DNS_RECORD_DELETED, {
              name: displayName,
              type: record.type
            });
          } catch (error) {
            logger.error(`Error deleting orphaned record ${displayName}: ${error.message}`);
          }
        }
        
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