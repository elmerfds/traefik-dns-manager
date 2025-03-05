/**
 * DigitalOcean DNS Provider
 * Core implementation of the DNSProvider interface for DigitalOcean
 */
const axios = require('axios');
const DNSProvider = require('../base');
const logger = require('../../utils/logger');
const { convertToDigitalOceanFormat } = require('./converter');
const { validateRecord } = require('./validator');

class DigitalOceanProvider extends DNSProvider {
  constructor(config) {
    super(config);
    
    logger.trace('DigitalOceanProvider.constructor: Initializing with config');
    
    this.token = config.digitalOceanToken;
    this.domain = config.digitalOceanDomain;
    
    // Initialize Axios client
    this.client = axios.create({
      baseURL: 'https://api.digitalocean.com/v2',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    logger.trace('DigitalOceanProvider.constructor: Axios client initialized');
  }
  
  /**
   * Initialize API
   */
  async init() {
    logger.trace(`DigitalOceanProvider.init: Starting initialization for domain "${this.domain}"`);
    
    try {
      // Verify domain exists in DigitalOcean
      logger.trace('DigitalOceanProvider.init: Verifying domain in DigitalOcean');
      await this.client.get(`/domains/${this.domain}`);
      
      logger.debug(`DigitalOcean domain verified: ${this.domain}`);
      logger.success('DigitalOcean domain authenticated successfully');
      
      // Initialize the DNS record cache
      logger.trace('DigitalOceanProvider.init: Initializing DNS record cache');
      await this.refreshRecordCache();
      
      return true;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        logger.error(`Domain not found in DigitalOcean: ${this.domain}`);
        throw new Error(`Domain not found in DigitalOcean: ${this.domain}`);
      }
      
      logger.error(`Failed to initialize DigitalOcean API: ${error.message}`);
      if (error.response && error.response.data) {
        logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
      }
      logger.trace(`DigitalOceanProvider.init: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw new Error(`Failed to initialize DigitalOcean API: ${error.message}`);
    }
  }
  
  /**
   * Refresh the DNS record cache
   */
  async refreshRecordCache() {
    logger.trace('DigitalOceanProvider.refreshRecordCache: Starting cache refresh');
    
    try {
      logger.debug('Refreshing DNS record cache from DigitalOcean');
      
      // Get all records for the domain in one API call
      logger.trace(`DigitalOceanProvider.refreshRecordCache: Fetching records for domain ${this.domain}`);
      
      const response = await this.client.get(`/domains/${this.domain}/records?per_page=100`);
      
      const oldRecordCount = this.recordCache.records.length;
      
      this.recordCache = {
        records: response.data.domain_records,
        lastUpdated: Date.now()
      };
      
      logger.debug(`Cached ${this.recordCache.records.length} DNS records from DigitalOcean`);
      logger.trace(`DigitalOceanProvider.refreshRecordCache: Cache updated from ${oldRecordCount} to ${this.recordCache.records.length} records`);
      
      // If there are more records (pagination), fetch them as well
      let nextPage = 2;
      let totalPages = Math.ceil(response.data.meta.total / 100);
      
      while (nextPage <= totalPages) {
        logger.debug(`Fetching additional DNS records page from DigitalOcean (page ${nextPage})`);
        logger.trace(`DigitalOceanProvider.refreshRecordCache: Fetching page ${nextPage}`);
        
        const pageResponse = await this.client.get(`/domains/${this.domain}/records?per_page=100&page=${nextPage}`);
        
        const newRecords = pageResponse.data.domain_records;
        logger.trace(`DigitalOceanProvider.refreshRecordCache: Received ${newRecords.length} additional records from page ${nextPage}`);
        
        this.recordCache.records = [
          ...this.recordCache.records,
          ...newRecords
        ];
        
        nextPage++;
      }
      
      logger.debug(`DNS record cache now contains ${this.recordCache.records.length} records`);
      
      // In TRACE mode, output the entire cache for debugging
      if (logger.level >= 4) { // TRACE level
        logger.trace('DigitalOceanProvider.refreshRecordCache: Current cache contents:');
        this.recordCache.records.forEach((record, index) => {
          logger.trace(`Record[${index}]: type=${record.type}, name=${record.name}, data=${record.data}`);
        });
      }
      
      return this.recordCache.records;
    } catch (error) {
      logger.error(`Failed to refresh DNS record cache: ${error.message}`);
      if (error.response && error.response.data) {
        logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
      }
      logger.trace(`DigitalOceanProvider.refreshRecordCache: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Update a record in the cache
   */
  updateRecordInCache(record) {
    logger.trace(`DigitalOceanProvider.updateRecordInCache: Updating record in cache: ID=${record.id}, type=${record.type}, name=${record.name}`);
    
    const index = this.recordCache.records.findIndex(
      r => r.id === record.id
    );
    
    if (index !== -1) {
      logger.trace(`DigitalOceanProvider.updateRecordInCache: Found existing record at index ${index}, replacing`);
      this.recordCache.records[index] = record;
    } else {
      logger.trace(`DigitalOceanProvider.updateRecordInCache: Record not found in cache, adding new record`);
      this.recordCache.records.push(record);
    }
  }
  
  /**
   * Remove a record from the cache
   */
  removeRecordFromCache(id) {
    logger.trace(`DigitalOceanProvider.removeRecordFromCache: Removing record ID=${id} from cache`);
    
    const initialLength = this.recordCache.records.length;
    this.recordCache.records = this.recordCache.records.filter(
      record => record.id !== id
    );
    
    const removed = initialLength - this.recordCache.records.length;
    logger.trace(`DigitalOceanProvider.removeRecordFromCache: Removed ${removed} records from cache`);
  }
  
  /**
   * List DNS records with optional filtering
   */
  async listRecords(params = {}) {
    logger.trace(`DigitalOceanProvider.listRecords: Listing records with params: ${JSON.stringify(params)}`);
    
    try {
      const records = await this.getRecordsFromCache();
      
      // Apply filters
      const filteredRecords = records.filter(record => {
        let match = true;
        
        if (params.type && record.type !== params.type) {
          match = false;
        }
        
        if (params.name) {
          // DigitalOcean stores names without the domain, so we need to handle matching differently
          const fullName = record.name === '@' ? this.domain : `${record.name}.${this.domain}`;
          if (fullName !== params.name) {
            match = false;
          }
        }
        
        return match;
      });
      
      logger.trace(`DigitalOceanProvider.listRecords: Filtered to ${filteredRecords.length} records`);
      
      return filteredRecords;
    } catch (error) {
      logger.error(`Failed to list DNS records: ${error.message}`);
      if (error.response && error.response.data) {
        logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
      }
      logger.trace(`DigitalOceanProvider.listRecords: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Create a new DNS record
   */
  async createRecord(record) {
    logger.trace(`DigitalOceanProvider.createRecord: Creating record type=${record.type}, name=${record.name}, content=${record.content}`);
    
    try {
      // Validate the record first
      validateRecord(record);
      
      // Convert to DigitalOcean format
      const doRecord = convertToDigitalOceanFormat(record, this.domain);
      
      logger.trace(`DigitalOceanProvider.createRecord: Sending create request to DigitalOcean API: ${JSON.stringify(doRecord)}`);
      logger.debug(`Creating ${record.type} record in DigitalOcean: ${JSON.stringify(doRecord)}`);
      
      const response = await this.client.post(
        `/domains/${this.domain}/records`,
        doRecord
      );
      
      const createdRecord = response.data.domain_record;
      logger.trace(`DigitalOceanProvider.createRecord: Record created successfully, ID=${createdRecord.id}`);
      
      // Update the cache with the new record
      this.updateRecordInCache(createdRecord);
      
      // Log at INFO level which record was created
      logger.info(`✨ Created ${record.type} record for ${record.name}`);
      logger.success(`Created ${record.type} record for ${record.name}`);
      
      // Update stats counter if available
      if (global.statsCounter) {
        global.statsCounter.created++;
        logger.trace(`DigitalOceanProvider.createRecord: Incremented global.statsCounter.created to ${global.statsCounter.created}`);
      }
      
      return createdRecord;
    } catch (error) {
      logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
      if (error.response && error.response.data) {
        logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
      }
      logger.trace(`DigitalOceanProvider.createRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Update an existing DNS record
   */
  async updateRecord(id, record) {
    logger.trace(`DigitalOceanProvider.updateRecord: Updating record ID=${id}, type=${record.type}, name=${record.name}, content=${record.content}`);
    
    try {
      // Validate the record first
      validateRecord(record);
      
      // Convert to DigitalOcean format
      const doRecord = convertToDigitalOceanFormat(record, this.domain);
      
      logger.trace(`DigitalOceanProvider.updateRecord: Sending update request to DigitalOcean API: ${JSON.stringify(doRecord)}`);
      logger.debug(`Updating ${record.type} record in DigitalOcean: ${JSON.stringify(doRecord)}`);
      
      const response = await this.client.put(
        `/domains/${this.domain}/records/${id}`,
        doRecord
      );
      
      const updatedRecord = response.data.domain_record;
      logger.trace(`DigitalOceanProvider.updateRecord: Record updated successfully, ID=${updatedRecord.id}`);
      
      // Update the cache
      this.updateRecordInCache(updatedRecord);
      
      // Log at INFO level which record was updated
      logger.info(`📝 Updated ${record.type} record for ${record.name}`);
      logger.success(`Updated ${record.type} record for ${record.name}`);
      
      // Update stats counter if available
      if (global.statsCounter) {
        global.statsCounter.updated++;
        logger.trace(`DigitalOceanProvider.updateRecord: Incremented global.statsCounter.updated to ${global.statsCounter.updated}`);
      }
      
      return updatedRecord;
    } catch (error) {
      logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
      if (error.response && error.response.data) {
        logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
      }
      logger.trace(`DigitalOceanProvider.updateRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Delete a DNS record
   */
  async deleteRecord(id) {
    logger.trace(`DigitalOceanProvider.deleteRecord: Deleting record ID=${id}`);
    
    try {
      // Find the record in cache before deleting to log info
      const recordToDelete = this.recordCache.records.find(r => r.id === id);
      if (recordToDelete) {
        const name = recordToDelete.name === '@' ? this.domain : `${recordToDelete.name}.${this.domain}`;
        logger.info(`🗑️ Deleting DNS record: ${name} (${recordToDelete.type})`);
      }
      
      logger.trace(`DigitalOceanProvider.deleteRecord: Sending delete request to DigitalOcean API`);
      await this.client.delete(`/domains/${this.domain}/records/${id}`);
      
      // Update the cache
      this.removeRecordFromCache(id);
      
      logger.debug(`Deleted DNS record with ID ${id}`);
      logger.trace(`DigitalOceanProvider.deleteRecord: Record deletion successful`);
      
      return true;
    } catch (error) {
      logger.error(`Failed to delete DNS record with ID ${id}: ${error.message}`);
      if (error.response && error.response.data) {
        logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
      }
      logger.trace(`DigitalOceanProvider.deleteRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Batch process multiple DNS records at once
   */
  async batchEnsureRecords(recordConfigs) {
    if (!recordConfigs || recordConfigs.length === 0) {
      logger.trace('DigitalOceanProvider.batchEnsureRecords: No record configs provided, skipping');
      return [];
    }
    
    logger.debug(`Batch processing ${recordConfigs.length} DNS records`);
    logger.trace(`DigitalOceanProvider.batchEnsureRecords: Starting batch processing of ${recordConfigs.length} records`);
    
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
      logger.trace('DigitalOceanProvider.batchEnsureRecords: First pass - examining records');
      
      for (const recordConfig of recordConfigs) {
        try {
          logger.trace(`DigitalOceanProvider.batchEnsureRecords: Processing record ${recordConfig.name} (${recordConfig.type})`);
          
          // Handle apex domains that need IP lookup
          if ((recordConfig.needsIpLookup || recordConfig.content === 'pending') && recordConfig.type === 'A') {
            logger.trace(`DigitalOceanProvider.batchEnsureRecords: Record needs IP lookup: ${recordConfig.name}`);
            
            // Get public IP asynchronously
            const ip = await this.config.getPublicIP();
            if (ip) {
              logger.trace(`DigitalOceanProvider.batchEnsureRecords: Retrieved IP address: ${ip}`);
              recordConfig.content = ip;
              logger.debug(`Retrieved public IP for apex domain ${recordConfig.name}: ${ip}`);
            } else {
              logger.trace(`DigitalOceanProvider.batchEnsureRecords: Failed to retrieve IP address`);
              throw new Error(`Unable to determine public IP for apex domain A record: ${recordConfig.name}`);
            }
            // Remove the flag to avoid confusion
            delete recordConfig.needsIpLookup;
          }
          
          // Validate the record
          validateRecord(recordConfig);
          
          // Find existing record in cache
          // DigitalOcean uses different name conventions, so we need custom matching
          const recordName = this.getRecordNameForDO(recordConfig.name);
          const existing = this.findRecordInCacheByName(recordConfig.type, recordName);
          
          if (existing) {
            logger.trace(`DigitalOceanProvider.batchEnsureRecords: Found existing record ID=${existing.id}`);
            
            // Check if update is needed
            const needsUpdate = this.recordNeedsUpdate(existing, recordConfig);
            logger.trace(`DigitalOceanProvider.batchEnsureRecords: Record ${recordConfig.name} needs update: ${needsUpdate}`);
            
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
                logger.trace(`DigitalOceanProvider.batchEnsureRecords: Incremented global.statsCounter.upToDate to ${global.statsCounter.upToDate}`);
              }
            }
          } else {
            logger.trace(`DigitalOceanProvider.batchEnsureRecords: No existing record found, needs creation`);
            
            // Need to create a new record
            pendingChanges.create.push({
              record: recordConfig
            });
          }
        } catch (error) {
          logger.error(`Error processing ${recordConfig.name}: ${error.message}`);
          logger.trace(`DigitalOceanProvider.batchEnsureRecords: Error details: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
            logger.trace(`DigitalOceanProvider.batchEnsureRecords: Incremented global.statsCounter.errors to ${global.statsCounter.errors}`);
          }
        }
      }
      
      // Second pass: apply all changes
      logger.debug(`DNS changes: ${pendingChanges.create.length} to create, ${pendingChanges.update.length} to update, ${pendingChanges.unchanged.length} unchanged`);
      logger.trace('DigitalOceanProvider.batchEnsureRecords: Second pass - applying changes');
      
      // Create new records
      for (const { record } of pendingChanges.create) {
        try {
          logger.trace(`DigitalOceanProvider.batchEnsureRecords: Creating record ${record.name} (${record.type})`);
          // Log at INFO level which record will be created
          logger.info(`✨ Creating ${record.type} record for ${record.name}`);
          const result = await this.createRecord(record);
          results.push(result);
        } catch (error) {
          logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
          if (error.response && error.response.data) {
            logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
          }
          logger.trace(`DigitalOceanProvider.batchEnsureRecords: Create error: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Update existing records
      for (const { id, record } of pendingChanges.update) {
        try {
          logger.trace(`DigitalOceanProvider.batchEnsureRecords: Updating record ${record.name} (${record.type})`);
          // Log at INFO level which record will be updated
          logger.info(`📝 Updating ${record.type} record for ${record.name}`);
          const result = await this.updateRecord(id, record);
          results.push(result);
        } catch (error) {
          logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
          if (error.response && error.response.data) {
            logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
          }
          logger.trace(`DigitalOceanProvider.batchEnsureRecords: Update error: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Add unchanged records to results too
      for (const { existing } of pendingChanges.unchanged) {
        results.push(existing);
      }
      
      logger.trace(`DigitalOceanProvider.batchEnsureRecords: Batch processing complete, returning ${results.length} results`);
      return results;
    } catch (error) {
      logger.error(`Failed to batch process DNS records: ${error.message}`);
      if (error.response && error.response.data) {
        logger.debug(`DigitalOcean API error details: ${JSON.stringify(error.response.data)}`);
      }
      logger.trace(`DigitalOceanProvider.batchEnsureRecords: Error details: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get record name for DigitalOcean (strip domain suffix)
   */
  getRecordNameForDO(fqdn) {
    if (fqdn === this.domain) {
      return '@';
    }
    
    if (fqdn.endsWith(`.${this.domain}`)) {
      return fqdn.slice(0, -this.domain.length - 1);
    }
    
    return fqdn;
  }
  
  /**
   * Find a record in the cache by name (DigitalOcean specific)
   */
  findRecordInCacheByName(type, name) {
    return this.recordCache.records.find(
      record => record.type === type && record.name === name
    );
  }

  /**
   * Check if a record needs to be updated
   */
  recordNeedsUpdate(existing, newRecord) {
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Comparing records for ${newRecord.name}`);
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Existing: ${JSON.stringify(existing)}`);
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: New: ${JSON.stringify(newRecord)}`);
    
    // Extract name from FQDN for new record
    const newName = this.getRecordNameForDO(newRecord.name);
    
    // Map our internal content field to DO's data field
    let doContent = newRecord.content || '';
    
    // For CNAME records, make sure it ends with a dot
    if (newRecord.type === 'CNAME' && doContent && !doContent.endsWith('.')) {
      doContent = doContent + '.';
    }
    
    // Basic field comparison
    let needsUpdate = existing.data !== doContent;
    
    // If TTL is specified, compare it
    if (newRecord.ttl !== undefined) {
      needsUpdate = needsUpdate || (existing.ttl !== newRecord.ttl);
    }
    
    // If priority is specified for MX or SRV, compare it
    if (newRecord.priority !== undefined && ['MX', 'SRV'].includes(newRecord.type)) {
      needsUpdate = needsUpdate || (existing.priority !== newRecord.priority);
    }
    
    // Type-specific comparisons
    switch (newRecord.type) {
      case 'SRV':
        if (newRecord.weight !== undefined) {
          needsUpdate = needsUpdate || (existing.weight !== newRecord.weight);
        }
        if (newRecord.port !== undefined) {
          needsUpdate = needsUpdate || (existing.port !== newRecord.port);
        }
        break;
        
      case 'CAA':
        if (newRecord.flags !== undefined) {
          needsUpdate = needsUpdate || (existing.flags !== newRecord.flags);
        }
        if (newRecord.tag !== undefined) {
          needsUpdate = needsUpdate || (existing.tag !== newRecord.tag);
        }
        break;
    }
    
    // If an update is needed, log the specific differences at DEBUG level
    if (needsUpdate && logger.level >= 3) { // DEBUG level or higher
      logger.debug(`Record ${newRecord.name} needs update:`);
      if (existing.data !== doContent) 
        logger.debug(` - Content: ${existing.data} → ${doContent}`);
      if (newRecord.ttl !== undefined && existing.ttl !== newRecord.ttl) 
        logger.debug(` - TTL: ${existing.ttl} → ${newRecord.ttl}`);
      if (newRecord.priority !== undefined && existing.priority !== newRecord.priority) 
        logger.debug(` - Priority: ${existing.priority} → ${newRecord.priority}`);
    }
    
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Final result - needs update: ${needsUpdate}`);
    return needsUpdate;
  }
}

module.exports = DigitalOceanProvider;