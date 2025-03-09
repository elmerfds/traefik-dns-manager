/**
 * Cloudflare DNS Provider
 * Core implementation of the DNSProvider interface for Cloudflare
 */
const axios = require('axios');
const DNSProvider = require('../base');
const logger = require('../../utils/logger');
const { convertToCloudflareFormat } = require('./converter');
const { validateRecord } = require('./validator');

class CloudflareProvider extends DNSProvider {
  constructor(config) {
    super(config);
    
    logger.trace('CloudflareProvider.constructor: Initialising with config');
    
    this.token = config.cloudflareToken;
    this.zone = config.cloudflareZone;
    this.zoneId = null;
    
    // Initialize Axios client
    this.client = axios.create({
      baseURL: 'https://api.cloudflare.com/client/v4',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    logger.trace('CloudflareProvider.constructor: Axios client initialized');
  }
  
  /**
   * Initialize API by fetching zone ID
   */
  async init() {
    logger.trace(`CloudflareProvider.init: Starting initialization for zone "${this.zone}"`);
    
    try {
      // Look up zone ID
      logger.trace('CloudflareProvider.init: Fetching zone ID from Cloudflare');
      const response = await this.client.get('/zones', {
        params: { name: this.zone }
      });
      
      logger.trace(`CloudflareProvider.init: Received ${response.data.result.length} zones from API`);
      
      if (response.data.result.length === 0) {
        logger.trace(`CloudflareProvider.init: Zone "${this.zone}" not found in Cloudflare`);
        throw new Error(`Zone not found: ${this.zone}`);
      }
      
      this.zoneId = response.data.result[0].id;
      logger.debug(`Cloudflare zone ID for ${this.zone}: ${this.zoneId}`);
      logger.success('Cloudflare zone authenticated successfully');
      
      // Initialize the DNS record cache
      logger.trace('CloudflareProvider.init: Initialising DNS record cache');
      await this.refreshRecordCache();
      
      return true;
    } catch (error) {
      logger.error(`Failed to initialize Cloudflare API: ${error.message}`);
      logger.trace(`CloudflareProvider.init: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw new Error(`Failed to initialize Cloudflare API: ${error.message}`);
    }
  }
  
  /**
   * Refresh the DNS record cache
   */
  async refreshRecordCache() {
    logger.trace('CloudflareProvider.refreshRecordCache: Starting cache refresh');
    
    try {
      logger.debug('Refreshing DNS record cache from Cloudflare');
      
      if (!this.zoneId) {
        logger.trace('CloudflareProvider.refreshRecordCache: No zoneId, initialising first');
        await this.init();
        return;
      }
      
      // Get all records for the zone in one API call
      logger.trace(`CloudflareProvider.refreshRecordCache: Fetching records for zone ${this.zoneId}`);
      
      const response = await this.client.get(`/zones/${this.zoneId}/dns_records`, {
        params: { per_page: 100 } // Get as many records as possible in one request
      });
      
      const oldRecordCount = this.recordCache.records.length;
      
      this.recordCache = {
        records: response.data.result,
        lastUpdated: Date.now()
      };
      
      logger.debug(`Cached ${this.recordCache.records.length} DNS records from Cloudflare`);
      logger.trace(`CloudflareProvider.refreshRecordCache: Cache updated from ${oldRecordCount} to ${this.recordCache.records.length} records`);
      
      // If there are more records (pagination), fetch them as well
      let nextPage = response.data.result_info?.next_page_url;
      let pageCount = 1;
      
      while (nextPage) {
        pageCount++;
        logger.debug(`Fetching additional DNS records page from Cloudflare (page ${pageCount})`);
        logger.trace(`CloudflareProvider.refreshRecordCache: Fetching pagination URL: ${nextPage}`);
        
        const pageResponse = await axios.get(nextPage, {
          headers: this.client.defaults.headers
        });
        
        const newRecords = pageResponse.data.result;
        logger.trace(`CloudflareProvider.refreshRecordCache: Received ${newRecords.length} additional records from page ${pageCount}`);
        
        this.recordCache.records = [
          ...this.recordCache.records,
          ...newRecords
        ];
        
        nextPage = pageResponse.data.result_info?.next_page_url;
      }
      
      logger.debug(`DNS record cache now contains ${this.recordCache.records.length} records`);
      
      // In TRACE mode, output the entire cache for debugging
      if (logger.level >= 4) { // TRACE level
        logger.trace('CloudflareProvider.refreshRecordCache: Current cache contents:');
        this.recordCache.records.forEach((record, index) => {
          logger.trace(`Record[${index}]: type=${record.type}, name=${record.name}, content=${record.content}`);
        });
      }
      
      return this.recordCache.records;
    } catch (error) {
      logger.error(`Failed to refresh DNS record cache: ${error.message}`);
      logger.trace(`CloudflareProvider.refreshRecordCache: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Update a record in the cache
   */
  updateRecordInCache(record) {
    logger.trace(`CloudflareProvider.updateRecordInCache: Updating record in cache: ID=${record.id}, type=${record.type}, name=${record.name}`);
    
    const index = this.recordCache.records.findIndex(
      r => r.id === record.id
    );
    
    if (index !== -1) {
      logger.trace(`CloudflareProvider.updateRecordInCache: Found existing record at index ${index}, replacing`);
      this.recordCache.records[index] = record;
    } else {
      logger.trace(`CloudflareProvider.updateRecordInCache: Record not found in cache, adding new record`);
      this.recordCache.records.push(record);
    }
  }
  
  /**
   * Remove a record from the cache
   */
  removeRecordFromCache(id) {
    logger.trace(`CloudflareProvider.removeRecordFromCache: Removing record ID=${id} from cache`);
    
    const initialLength = this.recordCache.records.length;
    this.recordCache.records = this.recordCache.records.filter(
      record => record.id !== id
    );
    
    const removed = initialLength - this.recordCache.records.length;
    logger.trace(`CloudflareProvider.removeRecordFromCache: Removed ${removed} records from cache`);
  }
  
  /**
   * List DNS records with optional filtering
   */
  async listRecords(params = {}) {
    logger.trace(`CloudflareProvider.listRecords: Listing records with params: ${JSON.stringify(params)}`);
    
    try {
      // If specific filters are used other than type and name, bypass cache
      const bypassCache = Object.keys(params).some(
        key => !['type', 'name'].includes(key)
      );
      
      if (bypassCache) {
        logger.debug('Bypassing cache due to complex filters');
        logger.trace(`CloudflareProvider.listRecords: Bypassing cache due to filters: ${JSON.stringify(params)}`);
        
        if (!this.zoneId) {
          logger.trace('CloudflareProvider.listRecords: No zoneId, initialising first');
          await this.init();
        }
        
        logger.trace(`CloudflareProvider.listRecords: Directly querying Cloudflare API with filters`);
        const response = await this.client.get(`/zones/${this.zoneId}/dns_records`, {
          params
        });
        
        logger.trace(`CloudflareProvider.listRecords: API returned ${response.data.result.length} records`);
        return response.data.result;
      }
      
      // Use cache for simple type/name filtering
      logger.trace('CloudflareProvider.listRecords: Using cache with filters');
      const records = await this.getRecordsFromCache();
      
      // Apply filters
      const filteredRecords = records.filter(record => {
        let match = true;
        
        if (params.type && record.type !== params.type) {
          match = false;
        }
        
        if (params.name && record.name !== params.name) {
          match = false;
        }
        
        return match;
      });
      
      logger.trace(`CloudflareProvider.listRecords: Cache filtering returned ${filteredRecords.length} records`);
      
      return filteredRecords;
    } catch (error) {
      logger.error(`Failed to list DNS records: ${error.message}`);
      logger.trace(`CloudflareProvider.listRecords: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Create a new DNS record
   */
  async createRecord(record) {
    logger.trace(`CloudflareProvider.createRecord: Creating record type=${record.type}, name=${record.name}, content=${record.content}`);
    
    try {
      if (!this.zoneId) {
        logger.trace('CloudflareProvider.createRecord: No zoneId, initialising first');
        await this.init();
      }
      
      // Validate the record first
      validateRecord(record);
      
      // Add management comment
      const recordWithComment = {
        ...record,
        comment: 'Managed by Traefik DNS Manager'
      };
      
      // Convert to Cloudflare format if needed
      const cloudflareRecord = convertToCloudflareFormat(recordWithComment);
      
      logger.trace(`CloudflareProvider.createRecord: Sending create request to Cloudflare API: ${JSON.stringify(cloudflareRecord)}`);
      
      const response = await this.client.post(
        `/zones/${this.zoneId}/dns_records`,
        cloudflareRecord
      );
      
      const createdRecord = response.data.result;
      logger.trace(`CloudflareProvider.createRecord: Record created successfully, ID=${createdRecord.id}`);
      
      // Update the cache with the new record
      this.updateRecordInCache(createdRecord);
      
      // Log at INFO level which record was created
      logger.info(`✨ Created ${record.type} record for ${record.name}`);
      logger.success(`Created ${record.type} record for ${record.name}`);
      
      // Update stats counter if available
      if (global.statsCounter) {
        global.statsCounter.created++;
        logger.trace(`CloudflareProvider.createRecord: Incremented global.statsCounter.created to ${global.statsCounter.created}`);
      }
      
      return createdRecord;
    } catch (error) {
      logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
      logger.trace(`CloudflareProvider.createRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Update an existing DNS record
   */
  async updateRecord(id, record) {
    logger.trace(`CloudflareProvider.updateRecord: Updating record ID=${id}, type=${record.type}, name=${record.name}, content=${record.content}`);
    
    try {
      if (!this.zoneId) {
        logger.trace('CloudflareProvider.updateRecord: No zoneId, initialising first');
        await this.init();
      }
      
      // Validate the record first
      validateRecord(record);
      
      // Add management comment
      const recordWithComment = {
        ...record,
        comment: 'Managed by Traefik DNS Manager'
      };
      
      // Convert to Cloudflare format if needed
      const cloudflareRecord = convertToCloudflareFormat(recordWithComment);
      
      logger.trace(`CloudflareProvider.updateRecord: Sending update request to Cloudflare API: ${JSON.stringify(cloudflareRecord)}`);
      
      const response = await this.client.put(
        `/zones/${this.zoneId}/dns_records/${id}`,
        cloudflareRecord
      );
      
      const updatedRecord = response.data.result;
      logger.trace(`CloudflareProvider.updateRecord: Record updated successfully, ID=${updatedRecord.id}`);
      
      // Update the cache
      this.updateRecordInCache(updatedRecord);
      
      // Log at INFO level which record was updated
      logger.info(`📝 Updated ${record.type} record for ${record.name}`);
      logger.success(`Updated ${record.type} record for ${record.name}`);
      
      // Update stats counter if available
      if (global.statsCounter) {
        global.statsCounter.updated++;
        logger.trace(`CloudflareProvider.updateRecord: Incremented global.statsCounter.updated to ${global.statsCounter.updated}`);
      }
      
      return updatedRecord;
    } catch (error) {
      logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
      logger.trace(`CloudflareProvider.updateRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Delete a DNS record
   */
  async deleteRecord(id) {
    logger.trace(`CloudflareProvider.deleteRecord: Deleting record ID=${id}`);
    
    try {
      if (!this.zoneId) {
        logger.trace('CloudflareProvider.deleteRecord: No zoneId, initialising first');
        await this.init();
      }
      
      // Find the record in cache before deleting to log info
      const recordToDelete = this.recordCache.records.find(r => r.id === id);
      if (recordToDelete) {
        logger.info(`🗑️ Deleting DNS record: ${recordToDelete.name} (${recordToDelete.type})`);
      }
      
      logger.trace(`CloudflareProvider.deleteRecord: Sending delete request to Cloudflare API`);
      await this.client.delete(`/zones/${this.zoneId}/dns_records/${id}`);
      
      // Update the cache
      this.removeRecordFromCache(id);
      
      logger.debug(`Deleted DNS record with ID ${id}`);
      logger.trace(`CloudflareProvider.deleteRecord: Record deletion successful`);
      
      return true;
    } catch (error) {
      logger.error(`Failed to delete DNS record with ID ${id}: ${error.message}`);
      logger.trace(`CloudflareProvider.deleteRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Batch process multiple DNS records at once
   */
  async batchEnsureRecords(recordConfigs) {
    if (!recordConfigs || recordConfigs.length === 0) {
      logger.trace('CloudflareProvider.batchEnsureRecords: No record configs provided, skipping');
      return [];
    }
    
    logger.debug(`Batch processing ${recordConfigs.length} DNS records`);
    logger.trace(`CloudflareProvider.batchEnsureRecords: Starting batch processing of ${recordConfigs.length} records`);
    
    try {
      // Refresh cache if needed
      await this.getRecordsFromCache();
      
      // Process each record configuration
      const results = [];
      const pendingChanges = {
        create: [],
        update: [],
        unchanged: []
      };
      
      // First pass: examine all records and sort into categories
      logger.trace('CloudflareProvider.batchEnsureRecords: First pass - examining records');
      
      for (const recordConfig of recordConfigs) {
        try {
          logger.trace(`CloudflareProvider.batchEnsureRecords: Processing record ${recordConfig.name} (${recordConfig.type})`);
          
          // Handle apex domains that need IP lookup
          if ((recordConfig.needsIpLookup || recordConfig.content === 'pending') && recordConfig.type === 'A') {
            logger.trace(`CloudflareProvider.batchEnsureRecords: Record needs IP lookup: ${recordConfig.name}`);
            
            // Get public IP asynchronously
            const ip = await this.config.getPublicIP();
            if (ip) {
              logger.trace(`CloudflareProvider.batchEnsureRecords: Retrieved IP address: ${ip}`);
              recordConfig.content = ip;
              logger.debug(`Retrieved public IP for apex domain ${recordConfig.name}: ${ip}`);
            } else {
              logger.trace(`CloudflareProvider.batchEnsureRecords: Failed to retrieve IP address`);
              throw new Error(`Unable to determine public IP for apex domain A record: ${recordConfig.name}`);
            }
            // Remove the flag to avoid confusion
            delete recordConfig.needsIpLookup;
          }
          
          // Validate the record
          validateRecord(recordConfig);
          
          // Find existing record in cache
          const existing = this.findRecordInCache(recordConfig.type, recordConfig.name);
          
          if (existing) {
            logger.trace(`CloudflareProvider.batchEnsureRecords: Found existing record ID=${existing.id}`);
            
            // Check if update is needed
            const needsUpdate = this.recordNeedsUpdate(existing, recordConfig);
            logger.trace(`CloudflareProvider.batchEnsureRecords: Record ${recordConfig.name} needs update: ${needsUpdate}`);
            
            if (needsUpdate) {
              pendingChanges.update.push({
                id: existing.id,
                record: recordConfig,
                existing
              });
            } else {
              pendingChanges.unchanged.push({
                record: recordConfig,
                existing
              });
              
              // Update stats counter if available
              if (global.statsCounter) {
                global.statsCounter.upToDate++;
                logger.trace(`CloudflareProvider.batchEnsureRecords: Incremented global.statsCounter.upToDate to ${global.statsCounter.upToDate}`);
              }
            }
          } else {
            logger.trace(`CloudflareProvider.batchEnsureRecords: No existing record found, needs creation`);
            
            // Need to create a new record
            pendingChanges.create.push({
              record: recordConfig
            });
          }
        } catch (error) {
          logger.error(`Error processing ${recordConfig.name}: ${error.message}`);
          logger.trace(`CloudflareProvider.batchEnsureRecords: Error details: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
            logger.trace(`CloudflareProvider.batchEnsureRecords: Incremented global.statsCounter.errors to ${global.statsCounter.errors}`);
          }
        }
      }
      
      // Second pass: apply all changes
      logger.debug(`DNS changes: ${pendingChanges.create.length} to create, ${pendingChanges.update.length} to update, ${pendingChanges.unchanged.length} unchanged`);
      logger.trace('CloudflareProvider.batchEnsureRecords: Second pass - applying changes');
      
      // Create new records
      for (const { record } of pendingChanges.create) {
        try {
          logger.trace(`CloudflareProvider.batchEnsureRecords: Creating record ${record.name} (${record.type})`);
          // Log at INFO level which record will be created
          logger.info(`✨ Creating ${record.type} record for ${record.name}`);
          const result = await this.createRecord(record);
          results.push(result);
        } catch (error) {
          logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
          logger.trace(`CloudflareProvider.batchEnsureRecords: Create error: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Update existing records
      for (const { id, record } of pendingChanges.update) {
        try {
          logger.trace(`CloudflareProvider.batchEnsureRecords: Updating record ${record.name} (${record.type})`);
          // Log at INFO level which record will be updated
          logger.info(`📝 Updating ${record.type} record for ${record.name}`);
          const result = await this.updateRecord(id, record);
          results.push(result);
        } catch (error) {
          logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
          logger.trace(`CloudflareProvider.batchEnsureRecords: Update error: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Add unchanged records to results too
      for (const { existing } of pendingChanges.unchanged) {
        results.push(existing);
      }
      
      logger.trace(`CloudflareProvider.batchEnsureRecords: Batch processing complete, returning ${results.length} results`);
      return results;
    } catch (error) {
      logger.error(`Failed to batch process DNS records: ${error.message}`);
      logger.trace(`CloudflareProvider.batchEnsureRecords: Error details: ${error.message}`);
      throw error;
    }
  }
  
/**
 * Check if a record needs to be updated
 */
recordNeedsUpdate(existing, newRecord) {
    logger.trace(`CloudflareProvider.recordNeedsUpdate: Comparing records for ${newRecord.name}`);
    logger.trace(`CloudflareProvider.recordNeedsUpdate: Existing: ${JSON.stringify(existing)}`);
    logger.trace(`CloudflareProvider.recordNeedsUpdate: New: ${JSON.stringify(newRecord)}`);
    
    // For proxied records in Cloudflare, TTL is always forced to 1 (Auto)
    // So we should ignore TTL differences for proxied records
    const isProxiedRecord = existing.proxied === true || newRecord.proxied === true;
    
    // Basic field comparison
    let needsUpdate = existing.content !== newRecord.content;
    
    // Only compare TTL for non-proxied records
    if (!isProxiedRecord) {
      needsUpdate = needsUpdate || (existing.ttl !== newRecord.ttl);
    }
    
    logger.trace(`CloudflareProvider.recordNeedsUpdate: Basic comparison - content: ${existing.content} vs ${newRecord.content}, ttl: ${existing.ttl} vs ${newRecord.ttl}`);
    
    // Only compare proxied for supported record types
    if (['A', 'AAAA', 'CNAME'].includes(newRecord.type)) {
      const proxiedDiff = existing.proxied !== newRecord.proxied;
      logger.trace(`CloudflareProvider.recordNeedsUpdate: Proxied status - existing: ${existing.proxied}, new: ${newRecord.proxied}, different: ${proxiedDiff}`);
      
      if (proxiedDiff) {
        // Log at INFO level to make proxied status changes more visible
        if (newRecord.proxied === false) {
          logger.info(`🔓 Disabling Cloudflare proxy for ${newRecord.name} (changing from proxied to unproxied)`);
        } else {
          logger.info(`🔒 Enabling Cloudflare proxy for ${newRecord.name} (changing from unproxied to proxied)`);
        }
      }
      
      needsUpdate = needsUpdate || proxiedDiff;
    }
    
    // Type-specific field comparisons
    switch (newRecord.type) {
      case 'MX':
        const mxDiff = existing.priority !== newRecord.priority;
        logger.trace(`CloudflareProvider.recordNeedsUpdate: MX priority - existing: ${existing.priority}, new: ${newRecord.priority}, different: ${mxDiff}`);
        needsUpdate = needsUpdate || mxDiff;
        break;
        
      case 'SRV':
        const srvPriorityDiff = existing.priority !== newRecord.priority;
        const srvWeightDiff = existing.weight !== newRecord.weight;
        const srvPortDiff = existing.port !== newRecord.port;
        
        logger.trace(`CloudflareProvider.recordNeedsUpdate: SRV fields - priority diff: ${srvPriorityDiff}, weight diff: ${srvWeightDiff}, port diff: ${srvPortDiff}`);
        
        needsUpdate = needsUpdate || 
          srvPriorityDiff ||
          srvWeightDiff ||
          srvPortDiff;
        break;
        
      case 'CAA':
        const caaFlagsDiff = existing.flags !== newRecord.flags;
        const caaTagDiff = existing.tag !== newRecord.tag;
        
        logger.trace(`CloudflareProvider.recordNeedsUpdate: CAA fields - flags diff: ${caaFlagsDiff}, tag diff: ${caaTagDiff}`);
        
        needsUpdate = needsUpdate || 
          caaFlagsDiff ||
          caaTagDiff;
        break;
    }
    
    // If an update is needed, log the specific differences at DEBUG level
    if (needsUpdate && logger.level >= 3) { // DEBUG level or higher
      logger.debug(`Record ${newRecord.name} needs update:`);
      if (existing.content !== newRecord.content) 
        logger.debug(` - Content: ${existing.content} → ${newRecord.content}`);
      if (!isProxiedRecord && existing.ttl !== newRecord.ttl) 
        logger.debug(` - TTL: ${existing.ttl} → ${newRecord.ttl}`);
      if (['A', 'AAAA', 'CNAME'].includes(newRecord.type) && existing.proxied !== newRecord.proxied)
        logger.debug(` - Proxied: ${existing.proxied} → ${newRecord.proxied}`);
    }
    
    logger.trace(`CloudflareProvider.recordNeedsUpdate: Final result - needs update: ${needsUpdate}`);
    return needsUpdate;
  }
}

module.exports = CloudflareProvider;