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
   * Initialize API by verifying domain exists
   */
  async init() {
    logger.trace(`DigitalOceanProvider.init: Starting initialization for domain "${this.domain}"`);
    
    try {
      // Verify the domain exists
      logger.trace('DigitalOceanProvider.init: Verifying domain exists in DigitalOcean');
      await this.client.get(`/domains/${this.domain}`);
      
      logger.debug(`DigitalOcean domain verified: ${this.domain}`);
      logger.success('DigitalOcean domain authenticated successfully');
      
      // Initialize the DNS record cache
      logger.trace('DigitalOceanProvider.init: Initializing DNS record cache');
      await this.refreshRecordCache();
      
      return true;
    } catch (error) {
      const statusCode = error.response?.status;
      
      if (statusCode === 404) {
        logger.error(`Domain not found in DigitalOcean: ${this.domain}`);
        throw new Error(`Domain not found in DigitalOcean: ${this.domain}`);
      } else if (statusCode === 401) {
        logger.error('Invalid DigitalOcean API token');
        throw new Error('Invalid DigitalOcean API token. Please check your DIGITALOCEAN_TOKEN environment variable.');
      }
      
      logger.error(`Failed to initialize DigitalOcean API: ${error.message}`);
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
      
      // Get all records for the domain
      logger.trace(`DigitalOceanProvider.refreshRecordCache: Fetching records for domain ${this.domain}`);
      
      const records = await this.fetchAllRecords();
      const oldRecordCount = this.recordCache.records.length;
      
      this.recordCache = {
        records: records,
        lastUpdated: Date.now()
      };
      
      logger.debug(`Cached ${this.recordCache.records.length} DNS records from DigitalOcean`);
      logger.trace(`DigitalOceanProvider.refreshRecordCache: Cache updated from ${oldRecordCount} to ${this.recordCache.records.length} records`);
      
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
      logger.trace(`DigitalOceanProvider.refreshRecordCache: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Fetch all records, handling pagination
   */
  async fetchAllRecords() {
    let allRecords = [];
    let nextPage = 1;
    let hasMorePages = true;
    
    while (hasMorePages) {
      try {
        const response = await this.client.get(`/domains/${this.domain}/records`, {
          params: { page: nextPage, per_page: 100 }
        });
        
        const records = response.data.domain_records || [];
        allRecords = allRecords.concat(records);
        
        // Check if there are more pages
        const links = response.data.links;
        const hasNextPage = links && links.pages && links.pages.next;
        
        if (hasNextPage) {
          nextPage++;
        } else {
          hasMorePages = false;
        }
      } catch (error) {
        logger.error(`Error fetching page ${nextPage} of DNS records: ${error.message}`);
        hasMorePages = false;
      }
    }
    
    return allRecords;
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
      // If specific filters are used other than type and name, bypass cache
      const bypassCache = Object.keys(params).some(
        key => !['type', 'name'].includes(key)
      );
      
      if (bypassCache) {
        logger.debug('Bypassing cache due to complex filters');
        logger.trace(`DigitalOceanProvider.listRecords: Bypassing cache due to filters: ${JSON.stringify(params)}`);
        
        const records = await this.fetchAllRecords();
        
        // Apply filters manually since DO API has limited filtering
        const filteredRecords = records.filter(record => {
          let match = true;
          
          if (params.type && record.type !== params.type) {
            match = false;
          }
          
          if (params.name) {
            // Handle the @ symbol for apex domain
            const recordName = record.name === '@' ? this.domain : `${record.name}.${this.domain}`;
            if (recordName !== params.name) {
              match = false;
            }
          }
          
          return match;
        });
        
        logger.trace(`DigitalOceanProvider.listRecords: API filtering returned ${filteredRecords.length} records`);
        return filteredRecords;
      }
      
      // Use cache for simple type/name filtering
      logger.trace('DigitalOceanProvider.listRecords: Using cache with filters');
      const records = await this.getRecordsFromCache();
      
      // Apply filters
      const filteredRecords = records.filter(record => {
        let match = true;
        
        if (params.type && record.type !== params.type) {
          match = false;
        }
        
        if (params.name) {
          // Handle the @ symbol for apex domain
          const recordName = record.name === '@' ? this.domain : `${record.name}.${this.domain}`;
          if (recordName !== params.name) {
            match = false;
          }
        }
        
        return match;
      });
      
      logger.trace(`DigitalOceanProvider.listRecords: Cache filtering returned ${filteredRecords.length} records`);
      
      return filteredRecords;
    } catch (error) {
      logger.error(`Failed to list DNS records: ${error.message}`);
      logger.trace(`DigitalOceanProvider.listRecords: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Find a record in the cache
   * Override the base method to handle DigitalOcean's @ symbol for apex domains
   */
  findRecordInCache(type, name) {
    // First normalize the name to handle apex domain scenarios
    const domainPart = `.${this.domain}`;
    
    // If the name ends with the domain, extract the subdomain part
    let recordName = name;
    if (name.endsWith(domainPart)) {
      recordName = name.slice(0, -domainPart.length);
      // If the name is exactly the domain, use @ for the apex
      if (recordName === '') {
        recordName = '@';
      }
    }
    
    logger.trace(`DigitalOceanProvider.findRecordInCache: Looking for ${type} record with name ${recordName}`);
    
    return this.recordCache.records.find(
      record => record.type === type && record.name === recordName
    );
  }
  
  /**
   * Create a new DNS record
   */
  async createRecord(record) {
    logger.trace(`DigitalOceanProvider.createRecord: Creating record type=${record.type}, name=${record.name}, content=${record.content}`);
    
    try {
      // Validate the record first
      validateRecord(record);
      
      // Convert name format for DO - extract subdomain part
      const recordData = this.prepareRecordForCreation(record);
      
      // Convert to DigitalOcean format
      const doRecord = convertToDigitalOceanFormat(recordData);
      
      logger.trace(`DigitalOceanProvider.createRecord: Sending create request to DigitalOcean API: ${JSON.stringify(doRecord)}`);
      
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
      logger.trace(`DigitalOceanProvider.createRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Prepare record for creation by formatting it for DigitalOcean
   */
  prepareRecordForCreation(record) {
    // Make a copy of the record to avoid modifying the original
    const recordData = { ...record };
    
    // Handle the name format for DigitalOcean
    // DigitalOcean expects just the subdomain part, not the full domain
    const domainPart = `.${this.domain}`;
    if (recordData.name.endsWith(domainPart)) {
      recordData.name = recordData.name.slice(0, -domainPart.length);
      // If the name is exactly the domain, use @ for the apex
      if (recordData.name === '') {
        recordData.name = '@';
      }
    }
    
    return recordData;
  }
  
  /**
   * Update an existing DNS record
   */
  async updateRecord(id, record) {
    logger.trace(`DigitalOceanProvider.updateRecord: Updating record ID=${id}, type=${record.type}, name=${record.name}, content=${record.content}`);
    
    try {
      // Validate the record first
      validateRecord(record);
      
      // Convert name format for DO - extract subdomain part
      const recordData = this.prepareRecordForCreation(record);
      
      // Convert to DigitalOcean format
      const doRecord = convertToDigitalOceanFormat(recordData);
      
      logger.trace(`DigitalOceanProvider.updateRecord: Sending update request to DigitalOcean API: ${JSON.stringify(doRecord)}`);
      
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
        // Format the name to display the full domain
        const displayName = recordToDelete.name === '@' 
          ? this.domain 
          : `${recordToDelete.name}.${this.domain}`;
        logger.info(`🗑️ Deleting DNS record: ${displayName} (${recordToDelete.type})`);
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
          const existing = this.findRecordInCache(recordConfig.type, recordConfig.name);
          
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
      logger.trace(`DigitalOceanProvider.batchEnsureRecords: Error details: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Check if a record needs to be updated
   */
  recordNeedsUpdate(existing, newRecord) {
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Comparing records for ${newRecord.name}`);
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Existing: ${JSON.stringify(existing)}`);
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: New: ${JSON.stringify(newRecord)}`);
    
    // Extract the correct content field based on record type
    let existingContent;
    switch (existing.type) {
      case 'MX':
      case 'SRV':
      case 'CAA':
        existingContent = existing.data;
        break;
      default:
        existingContent = existing.data;
    }
    
    // Compare basic fields
    let needsUpdate = false;
    
    // Compare content/data
    if (existingContent !== newRecord.content) {
      logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Content different: ${existingContent} vs ${newRecord.content}`);
      needsUpdate = true;
    }
    
    // Compare TTL
    if (existing.ttl !== newRecord.ttl) {
      logger.trace(`DigitalOceanProvider.recordNeedsUpdate: TTL different: ${existing.ttl} vs ${newRecord.ttl}`);
      needsUpdate = true;
    }
    
    // Type-specific field comparisons
    switch (newRecord.type) {
      case 'MX':
        if (existing.priority !== newRecord.priority) {
          logger.trace(`DigitalOceanProvider.recordNeedsUpdate: MX priority different: ${existing.priority} vs ${newRecord.priority}`);
          needsUpdate = true;
        }
        break;
        
      case 'SRV':
        if (existing.priority !== newRecord.priority ||
            existing.weight !== newRecord.weight ||
            existing.port !== newRecord.port) {
          logger.trace(`DigitalOceanProvider.recordNeedsUpdate: SRV fields different`);
          needsUpdate = true;
        }
        break;
        
      case 'CAA':
        if (existing.flags !== newRecord.flags ||
            existing.tag !== newRecord.tag) {
          logger.trace(`DigitalOceanProvider.recordNeedsUpdate: CAA fields different`);
          needsUpdate = true;
        }
        break;
    }
    
    // If an update is needed, log the specific differences at DEBUG level
    if (needsUpdate && logger.level >= 3) { // DEBUG level or higher
      logger.debug(`Record ${newRecord.name} needs update:`);
      if (existingContent !== newRecord.content) 
        logger.debug(` - Content: ${existingContent} → ${newRecord.content}`);
      if (existing.ttl !== newRecord.ttl) 
        logger.debug(` - TTL: ${existing.ttl} → ${newRecord.ttl}`);
      
      // Log type-specific field changes
      switch (newRecord.type) {
        case 'MX':
          if (existing.priority !== newRecord.priority)
            logger.debug(` - Priority: ${existing.priority} → ${newRecord.priority}`);
          break;
          
        case 'SRV':
          if (existing.priority !== newRecord.priority)
            logger.debug(` - Priority: ${existing.priority} → ${newRecord.priority}`);
          if (existing.weight !== newRecord.weight)
            logger.debug(` - Weight: ${existing.weight} → ${newRecord.weight}`);
          if (existing.port !== newRecord.port)
            logger.debug(` - Port: ${existing.port} → ${newRecord.port}`);
          break;
          
        case 'CAA':
          if (existing.flags !== newRecord.flags)
            logger.debug(` - Flags: ${existing.flags} → ${newRecord.flags}`);
          if (existing.tag !== newRecord.tag)
            logger.debug(` - Tag: ${existing.tag} → ${newRecord.tag}`);
          break;
      }
    }
    
    logger.trace(`DigitalOceanProvider.recordNeedsUpdate: Final result - needs update: ${needsUpdate}`);
    return needsUpdate;
  }
}

module.exports = DigitalOceanProvider;