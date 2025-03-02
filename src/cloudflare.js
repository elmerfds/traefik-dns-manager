/**
 * Cloudflare API client for DNS management
 * Includes DNS record caching to reduce API calls
 */
const axios = require('axios');
const logger = require('./logger');

class CloudflareAPI {
  constructor(config) {
    logger.trace('CloudflareAPI.constructor: Initializing with config');
    
    this.config = config;
    this.token = config.cloudflareToken;
    this.zone = config.cloudflareZone;
    this.zoneId = null;
    
    // Initialize record cache
    this.recordCache = {
      records: [],
      lastUpdated: 0
    };
    
    // Cache refresh interval in milliseconds (default: 1 hour)
    this.cacheRefreshInterval = parseInt(process.env.DNS_CACHE_REFRESH_INTERVAL || '3600000', 10);
    
    logger.trace(`CloudflareAPI.constructor: Cache refresh interval set to ${this.cacheRefreshInterval}ms`);
    
    this.client = axios.create({
      baseURL: 'https://api.cloudflare.com/client/v4',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    logger.trace('CloudflareAPI.constructor: Axios client initialized');
  }
  
  /**
   * Initialize API by fetching zone ID
   */
  async init() {
    logger.trace(`CloudflareAPI.init: Starting initialization for zone "${this.zone}"`);
    
    try {
      // Look up zone ID
      logger.trace('CloudflareAPI.init: Fetching zone ID from Cloudflare');
      const response = await this.client.get('/zones', {
        params: { name: this.zone }
      });
      
      logger.trace(`CloudflareAPI.init: Received ${response.data.result.length} zones from API`);
      
      if (response.data.result.length === 0) {
        logger.trace(`CloudflareAPI.init: Zone "${this.zone}" not found in Cloudflare`);
        throw new Error(`Zone not found: ${this.zone}`);
      }
      
      this.zoneId = response.data.result[0].id;
      logger.debug(`Cloudflare zone ID for ${this.zone}: ${this.zoneId}`);
      logger.success('Cloudflare zone authenticated successfully');
      
      // Initialize the DNS record cache
      logger.trace('CloudflareAPI.init: Initializing DNS record cache');
      await this.refreshRecordCache();
      
      return true;
    } catch (error) {
      logger.error(`Failed to initialize Cloudflare API: ${error.message}`);
      logger.trace(`CloudflareAPI.init: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw new Error(`Failed to initialize Cloudflare API: ${error.message}`);
    }
  }
  
  /**
   * Refresh the DNS record cache
   */
  async refreshRecordCache() {
    logger.trace('CloudflareAPI.refreshRecordCache: Starting cache refresh');
    
    try {
      logger.debug('Refreshing DNS record cache from Cloudflare');
      
      if (!this.zoneId) {
        logger.trace('CloudflareAPI.refreshRecordCache: No zoneId, initializing first');
        await this.init();
        return;
      }
      
      // Get all records for the zone in one API call
      logger.trace(`CloudflareAPI.refreshRecordCache: Fetching records for zone ${this.zoneId}`);
      
      const response = await this.client.get(`/zones/${this.zoneId}/dns_records`, {
        params: { per_page: 100 } // Get as many records as possible in one request
      });
      
      const oldRecordCount = this.recordCache.records.length;
      
      this.recordCache = {
        records: response.data.result,
        lastUpdated: Date.now()
      };
      
      logger.debug(`Cached ${this.recordCache.records.length} DNS records from Cloudflare`);
      logger.trace(`CloudflareAPI.refreshRecordCache: Cache updated from ${oldRecordCount} to ${this.recordCache.records.length} records`);
      
      // If there are more records (pagination), fetch them as well
      let nextPage = response.data.result_info?.next_page_url;
      let pageCount = 1;
      
      while (nextPage) {
        pageCount++;
        logger.debug(`Fetching additional DNS records page from Cloudflare (page ${pageCount})`);
        logger.trace(`CloudflareAPI.refreshRecordCache: Fetching pagination URL: ${nextPage}`);
        
        const pageResponse = await axios.get(nextPage, {
          headers: this.client.defaults.headers
        });
        
        const newRecords = pageResponse.data.result;
        logger.trace(`CloudflareAPI.refreshRecordCache: Received ${newRecords.length} additional records from page ${pageCount}`);
        
        this.recordCache.records = [
          ...this.recordCache.records,
          ...newRecords
        ];
        
        nextPage = pageResponse.data.result_info?.next_page_url;
      }
      
      logger.debug(`DNS record cache now contains ${this.recordCache.records.length} records`);
      
      // In TRACE mode, output the entire cache for debugging
      if (logger.level >= 4) { // TRACE level
        logger.trace('CloudflareAPI.refreshRecordCache: Current cache contents:');
        this.recordCache.records.forEach((record, index) => {
          logger.trace(`Record[${index}]: type=${record.type}, name=${record.name}, content=${record.content}`);
        });
      }
      
      return this.recordCache.records;
    } catch (error) {
      logger.error(`Failed to refresh DNS record cache: ${error.message}`);
      logger.trace(`CloudflareAPI.refreshRecordCache: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Get records from cache, refreshing if necessary
   */
  async getRecordsFromCache(forceRefresh = false) {
    const cacheAge = Date.now() - this.recordCache.lastUpdated;
    
    logger.trace(`CloudflareAPI.getRecordsFromCache: Cache age is ${cacheAge}ms, threshold is ${this.cacheRefreshInterval}ms`);
    logger.trace(`CloudflareAPI.getRecordsFromCache: Force refresh: ${forceRefresh}, Cache size: ${this.recordCache.records.length}`);
    
    // Check if cache is stale or if force refresh is requested
    if (forceRefresh || cacheAge > this.cacheRefreshInterval || this.recordCache.records.length === 0) {
      logger.trace('CloudflareAPI.getRecordsFromCache: Cache needs refresh, calling refreshRecordCache()');
      await this.refreshRecordCache();
    } else {
      logger.trace('CloudflareAPI.getRecordsFromCache: Using existing cache');
    }
    
    return this.recordCache.records;
  }
  
  /**
   * Find a record in the cache
   */
  findRecordInCache(type, name) {
    logger.trace(`CloudflareAPI.findRecordInCache: Looking for record type=${type}, name=${name}`);
    
    const record = this.recordCache.records.find(
      record => record.type === type && record.name === name
    );
    
    if (record) {
      logger.trace(`CloudflareAPI.findRecordInCache: Found record ID=${record.id}, content=${record.content}`);
    } else {
      logger.trace(`CloudflareAPI.findRecordInCache: No record found for type=${type}, name=${name}`);
    }
    
    return record;
  }
  
  /**
   * Update a record in the cache
   */
  updateRecordInCache(record) {
    logger.trace(`CloudflareAPI.updateRecordInCache: Updating record in cache: ID=${record.id}, type=${record.type}, name=${record.name}`);
    
    const index = this.recordCache.records.findIndex(
      r => r.id === record.id
    );
    
    if (index !== -1) {
      logger.trace(`CloudflareAPI.updateRecordInCache: Found existing record at index ${index}, replacing`);
      this.recordCache.records[index] = record;
    } else {
      logger.trace(`CloudflareAPI.updateRecordInCache: Record not found in cache, adding new record`);
      this.recordCache.records.push(record);
    }
  }
  
  /**
   * Remove a record from the cache
   */
  removeRecordFromCache(id) {
    logger.trace(`CloudflareAPI.removeRecordFromCache: Removing record ID=${id} from cache`);
    
    const initialLength = this.recordCache.records.length;
    this.recordCache.records = this.recordCache.records.filter(
      record => record.id !== id
    );
    
    const removed = initialLength - this.recordCache.records.length;
    logger.trace(`CloudflareAPI.removeRecordFromCache: Removed ${removed} records from cache`);
  }
  
  /**
   * List DNS records with optional filtering
   * Uses cache when possible, falls back to API if necessary
   */
  async listRecords(params = {}) {
    logger.trace(`CloudflareAPI.listRecords: Listing records with params: ${JSON.stringify(params)}`);
    
    try {
      // If specific filters are used other than type and name, bypass cache
      const bypassCache = Object.keys(params).some(
        key => !['type', 'name'].includes(key)
      );
      
      if (bypassCache) {
        logger.debug('Bypassing cache due to complex filters');
        logger.trace(`CloudflareAPI.listRecords: Bypassing cache due to filters: ${JSON.stringify(params)}`);
        
        if (!this.zoneId) {
          logger.trace('CloudflareAPI.listRecords: No zoneId, initializing first');
          await this.init();
        }
        
        logger.trace(`CloudflareAPI.listRecords: Directly querying Cloudflare API with filters`);
        const response = await this.client.get(`/zones/${this.zoneId}/dns_records`, {
          params
        });
        
        logger.trace(`CloudflareAPI.listRecords: API returned ${response.data.result.length} records`);
        return response.data.result;
      }
      
      // Use cache for simple type/name filtering
      logger.trace('CloudflareAPI.listRecords: Using cache with filters');
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
      
      logger.trace(`CloudflareAPI.listRecords: Cache filtering returned ${filteredRecords.length} records`);
      
      return filteredRecords;
    } catch (error) {
      logger.error(`Failed to list DNS records: ${error.message}`);
      logger.trace(`CloudflareAPI.listRecords: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Create a new DNS record
   */
  async createRecord(record) {
    logger.trace(`CloudflareAPI.createRecord: Creating record type=${record.type}, name=${record.name}, content=${record.content}`);
    
    try {
      if (!this.zoneId) {
        logger.trace('CloudflareAPI.createRecord: No zoneId, initializing first');
        await this.init();
      }
      
      // Add management comment
      const recordWithComment = {
        ...record,
        comment: 'Managed by Traefik DNS Manager'
      };
      
      logger.trace(`CloudflareAPI.createRecord: Sending create request to Cloudflare API: ${JSON.stringify(recordWithComment)}`);
      
      const response = await this.client.post(
        `/zones/${this.zoneId}/dns_records`,
        recordWithComment
      );
      
      const createdRecord = response.data.result;
      logger.trace(`CloudflareAPI.createRecord: Record created successfully, ID=${createdRecord.id}`);
      
      // Update the cache with the new record
      this.updateRecordInCache(createdRecord);
      
      logger.success(`Created ${record.type} record for ${record.name}`);
      
      // Update stats counter if available
      if (global.statsCounter) {
        global.statsCounter.created++;
        logger.trace(`CloudflareAPI.createRecord: Incremented global.statsCounter.created to ${global.statsCounter.created}`);
      }
      
      return createdRecord;
    } catch (error) {
      logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
      logger.trace(`CloudflareAPI.createRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Update an existing DNS record
   */
  async updateRecord(id, record) {
    logger.trace(`CloudflareAPI.updateRecord: Updating record ID=${id}, type=${record.type}, name=${record.name}, content=${record.content}`);
    
    try {
      if (!this.zoneId) {
        logger.trace('CloudflareAPI.updateRecord: No zoneId, initializing first');
        await this.init();
      }
      
      // Add management comment
      const recordWithComment = {
        ...record,
        comment: 'Managed by Traefik DNS Manager'
      };
      
      logger.trace(`CloudflareAPI.updateRecord: Sending update request to Cloudflare API: ${JSON.stringify(recordWithComment)}`);
      
      const response = await this.client.put(
        `/zones/${this.zoneId}/dns_records/${id}`,
        recordWithComment
      );
      
      const updatedRecord = response.data.result;
      logger.trace(`CloudflareAPI.updateRecord: Record updated successfully, ID=${updatedRecord.id}`);
      
      // Update the cache
      this.updateRecordInCache(updatedRecord);
      
      logger.success(`Updated ${record.type} record for ${record.name}`);
      
      // Update stats counter if available
      if (global.statsCounter) {
        global.statsCounter.updated++;
        logger.trace(`CloudflareAPI.updateRecord: Incremented global.statsCounter.updated to ${global.statsCounter.updated}`);
      }
      
      return updatedRecord;
    } catch (error) {
      logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
      logger.trace(`CloudflareAPI.updateRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Delete a DNS record
   */
  async deleteRecord(id) {
    logger.trace(`CloudflareAPI.deleteRecord: Deleting record ID=${id}`);
    
    try {
      if (!this.zoneId) {
        logger.trace('CloudflareAPI.deleteRecord: No zoneId, initializing first');
        await this.init();
      }
      
      logger.trace(`CloudflareAPI.deleteRecord: Sending delete request to Cloudflare API`);
      await this.client.delete(`/zones/${this.zoneId}/dns_records/${id}`);
      
      // Update the cache
      this.removeRecordFromCache(id);
      
      logger.debug(`Deleted DNS record with ID ${id}`);
      logger.trace(`CloudflareAPI.deleteRecord: Record deletion successful`);
      
      return true;
    } catch (error) {
      logger.error(`Failed to delete DNS record with ID ${id}: ${error.message}`);
      logger.trace(`CloudflareAPI.deleteRecord: Error details: ${JSON.stringify(error.response?.data || error.message)}`);
      throw error;
    }
  }
  
  /**
   * Batch process multiple DNS records at once
   * This significantly reduces API calls by processing all changes together
   */
  async batchEnsureRecords(recordConfigs) {
    if (!recordConfigs || recordConfigs.length === 0) {
      logger.trace('CloudflareAPI.batchEnsureRecords: No record configs provided, skipping');
      return [];
    }
    
    logger.debug(`Batch processing ${recordConfigs.length} DNS records`);
    logger.trace(`CloudflareAPI.batchEnsureRecords: Starting batch processing of ${recordConfigs.length} records`);
    
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
      logger.trace('CloudflareAPI.batchEnsureRecords: First pass - examining records');
      
      for (const recordConfig of recordConfigs) {
        try {
          logger.trace(`CloudflareAPI.batchEnsureRecords: Processing record ${recordConfig.name} (${recordConfig.type})`);
          
          // Handle apex domains that need IP lookup
          if ((recordConfig.needsIpLookup || recordConfig.content === 'pending') && recordConfig.type === 'A') {
            logger.trace(`CloudflareAPI.batchEnsureRecords: Record needs IP lookup: ${recordConfig.name}`);
            
            // Get public IP asynchronously
            const ip = await this.config.getPublicIP();
            if (ip) {
              logger.trace(`CloudflareAPI.batchEnsureRecords: Retrieved IP address: ${ip}`);
              recordConfig.content = ip;
              logger.debug(`Retrieved public IP for apex domain ${recordConfig.name}: ${ip}`);
            } else {
              logger.trace(`CloudflareAPI.batchEnsureRecords: Failed to retrieve IP address`);
              throw new Error(`Unable to determine public IP for apex domain A record: ${recordConfig.name}`);
            }
            // Remove the flag to avoid confusion
            delete recordConfig.needsIpLookup;
          }
          
          // Validate the record
          this.validateRecord(recordConfig);
          
          // Find existing record in cache
          const existing = this.findRecordInCache(recordConfig.type, recordConfig.name);
          
          if (existing) {
            logger.trace(`CloudflareAPI.batchEnsureRecords: Found existing record ID=${existing.id}`);
            
            // Check if update is needed
            const needsUpdate = this.recordNeedsUpdate(existing, recordConfig);
            logger.trace(`CloudflareAPI.batchEnsureRecords: Record ${recordConfig.name} needs update: ${needsUpdate}`);
            
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
                logger.trace(`CloudflareAPI.batchEnsureRecords: Incremented global.statsCounter.upToDate to ${global.statsCounter.upToDate}`);
              }
            }
          } else {
            logger.trace(`CloudflareAPI.batchEnsureRecords: No existing record found, needs creation`);
            
            // Need to create a new record
            pendingChanges.create.push({
              record: recordConfig
            });
          }
        } catch (error) {
          logger.error(`Error processing ${recordConfig.name}: ${error.message}`);
          logger.trace(`CloudflareAPI.batchEnsureRecords: Error details: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
            logger.trace(`CloudflareAPI.batchEnsureRecords: Incremented global.statsCounter.errors to ${global.statsCounter.errors}`);
          }
        }
      }
      
      // Second pass: apply all changes
      logger.debug(`DNS changes: ${pendingChanges.create.length} to create, ${pendingChanges.update.length} to update, ${pendingChanges.unchanged.length} unchanged`);
      logger.trace('CloudflareAPI.batchEnsureRecords: Second pass - applying changes');
      
      // Create new records
      for (const { record } of pendingChanges.create) {
        try {
          logger.trace(`CloudflareAPI.batchEnsureRecords: Creating record ${record.name} (${record.type})`);
          const result = await this.createRecord(record);
          results.push(result);
        } catch (error) {
          logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
          logger.trace(`CloudflareAPI.batchEnsureRecords: Create error: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Update existing records
      for (const { id, record } of pendingChanges.update) {
        try {
          logger.trace(`CloudflareAPI.batchEnsureRecords: Updating record ${record.name} (${record.type})`);
          const result = await this.updateRecord(id, record);
          results.push(result);
        } catch (error) {
          logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
          logger.trace(`CloudflareAPI.batchEnsureRecords: Update error: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Add unchanged records to results too
      for (const { existing } of pendingChanges.unchanged) {
        results.push(existing);
      }
      
      logger.trace(`CloudflareAPI.batchEnsureRecords: Batch processing complete, returning ${results.length} results`);
      return results;
    } catch (error) {
      logger.error(`Failed to batch process DNS records: ${error.message}`);
      logger.trace(`CloudflareAPI.batchEnsureRecords: Error details: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Ensure a DNS record exists and is up to date
   * This is the legacy method for ensuring a single record
   * For better performance, use batchEnsureRecords instead
   */
  async ensureRecord(record) {
    logger.trace(`CloudflareAPI.ensureRecord: Processing single record ${record.name} (${record.type})`);
    
    try {
      // Handle apex domains that need IP lookup
      if ((record.needsIpLookup || record.content === 'pending') && record.type === 'A') {
        logger.trace(`CloudflareAPI.ensureRecord: Record needs IP lookup: ${record.name}`);
        
        // Get public IP asynchronously
        const ip = await this.config.getPublicIP();
        if (ip) {
          logger.trace(`CloudflareAPI.ensureRecord: Retrieved IP address: ${ip}`);
          record.content = ip;
          logger.debug(`Retrieved public IP for apex domain ${record.name}: ${ip}`);
        } else {
          logger.trace(`CloudflareAPI.ensureRecord: Failed to retrieve IP address`);
          throw new Error(`Unable to determine public IP for apex domain A record: ${record.name}`);
        }
        // Remove the flag to avoid confusion
        delete record.needsIpLookup;
      }
      
      // Validate the record
      this.validateRecord(record);
      
      // Check cache first
      await this.getRecordsFromCache();
      const existingFromCache = this.findRecordInCache(record.type, record.name);
      
      if (existingFromCache) {
        logger.trace(`CloudflareAPI.ensureRecord: Found existing record ID=${existingFromCache.id}`);
        
        // Check if update is needed
        if (this.recordNeedsUpdate(existingFromCache, record)) {
          logger.trace(`CloudflareAPI.ensureRecord: Record needs update`);
          return await this.updateRecord(existingFromCache.id, record);
        }
        
        logger.debug(`${record.type} record for ${record.name} already up to date`);
        logger.trace(`CloudflareAPI.ensureRecord: Record is up to date`);
        
        // Update stats counter if available
        if (global.statsCounter) {
          global.statsCounter.upToDate++;
          logger.trace(`CloudflareAPI.ensureRecord: Incremented global.statsCounter.upToDate to ${global.statsCounter.upToDate}`);
        }
        
        return existingFromCache;
      } else {
        logger.trace(`CloudflareAPI.ensureRecord: No existing record found, needs creation`);
        // Create new record
        return await this.createRecord(record);
      }
    } catch (error) {
      logger.error(`Failed to ensure record for ${record.name}: ${error.message}`);
      logger.trace(`CloudflareAPI.ensureRecord: Error details: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Check if a record needs to be updated
   */
  recordNeedsUpdate(existing, newRecord) {
    logger.trace(`CloudflareAPI.recordNeedsUpdate: Comparing records for ${newRecord.name}`);
    logger.trace(`CloudflareAPI.recordNeedsUpdate: Existing: ${JSON.stringify(existing)}`);
    logger.trace(`CloudflareAPI.recordNeedsUpdate: New: ${JSON.stringify(newRecord)}`);
    
    // Basic field comparison
    let needsUpdate = (
      existing.content !== newRecord.content ||
      existing.ttl !== newRecord.ttl
    );
    
    logger.trace(`CloudflareAPI.recordNeedsUpdate: Basic comparison - content: ${existing.content} vs ${newRecord.content}, ttl: ${existing.ttl} vs ${newRecord.ttl}`);
    
    // Only compare proxied for supported record types
    if (['A', 'AAAA', 'CNAME'].includes(newRecord.type)) {
      const proxiedDiff = existing.proxied !== newRecord.proxied;
      logger.trace(`CloudflareAPI.recordNeedsUpdate: Proxied status - existing: ${existing.proxied}, new: ${newRecord.proxied}, different: ${proxiedDiff}`);
      needsUpdate = needsUpdate || proxiedDiff;
    }
    
    // Type-specific field comparisons
    switch (newRecord.type) {
      case 'MX':
        const mxDiff = existing.priority !== newRecord.priority;
        logger.trace(`CloudflareAPI.recordNeedsUpdate: MX priority - existing: ${existing.priority}, new: ${newRecord.priority}, different: ${mxDiff}`);
        needsUpdate = needsUpdate || mxDiff;
        break;
        
      case 'SRV':
        const srvPriorityDiff = existing.priority !== newRecord.priority;
        const srvWeightDiff = existing.weight !== newRecord.weight;
        const srvPortDiff = existing.port !== newRecord.port;
        
        logger.trace(`CloudflareAPI.recordNeedsUpdate: SRV fields - priority diff: ${srvPriorityDiff}, weight diff: ${srvWeightDiff}, port diff: ${srvPortDiff}`);
        
        needsUpdate = needsUpdate || 
          srvPriorityDiff ||
          srvWeightDiff ||
          srvPortDiff;
        break;
        
      case 'CAA':
        const caaFlagsDiff = existing.flags !== newRecord.flags;
        const caaTagDiff = existing.tag !== newRecord.tag;
        
        logger.trace(`CloudflareAPI.recordNeedsUpdate: CAA fields - flags diff: ${caaFlagsDiff}, tag diff: ${caaTagDiff}`);
        
        needsUpdate = needsUpdate || 
          caaFlagsDiff ||
          caaTagDiff;
        break;
    }
    
    logger.trace(`CloudflareAPI.recordNeedsUpdate: Final result - needs update: ${needsUpdate}`);
    return needsUpdate;
  }
  
  /**
   * Validate a record configuration
   */
  validateRecord(record) {
    logger.trace(`CloudflareAPI.validateRecord: Validating record ${record.name} (${record.type})`);
    
    // Common validations
    if (!record.type) {
      logger.trace(`CloudflareAPI.validateRecord: Record type is missing`);
      throw new Error('Record type is required');
    }
    
    if (!record.name) {
      logger.trace(`CloudflareAPI.validateRecord: Record name is missing`);
      throw new Error('Record name is required');
    }
    
    // Type-specific validations
    switch (record.type) {
      case 'A':
        if (!record.content) {
          logger.trace(`CloudflareAPI.validateRecord: IP address is missing for A record`);
          throw new Error('IP address is required for A records');
        }
        break;
        
      case 'AAAA':
        if (!record.content) {
          logger.trace(`CloudflareAPI.validateRecord: IPv6 address is missing for AAAA record`);
          throw new Error('IPv6 address is required for AAAA records');
        }
        break;
        
      case 'CNAME':
      case 'TXT':
      case 'NS':
        if (!record.content) {
          logger.trace(`CloudflareAPI.validateRecord: Content is missing for ${record.type} record`);
          throw new Error(`Content is required for ${record.type} records`);
        }
        break;
        
      case 'MX':
        if (!record.content) {
          logger.trace(`CloudflareAPI.validateRecord: Mail server is missing for MX record`);
          throw new Error('Mail server is required for MX records');
        }
        // Set default priority if missing
        if (record.priority === undefined) {
          logger.trace(`CloudflareAPI.validateRecord: Setting default priority (10) for MX record`);
          record.priority = 10;
        }
        break;
        
      case 'SRV':
        if (!record.content) {
          logger.trace(`CloudflareAPI.validateRecord: Target is missing for SRV record`);
          throw new Error('Target is required for SRV records');
        }
        // Set defaults for SRV fields
        if (record.priority === undefined) {
          logger.trace(`CloudflareAPI.validateRecord: Setting default priority (1) for SRV record`);
          record.priority = 1;
        }
        if (record.weight === undefined) {
          logger.trace(`CloudflareAPI.validateRecord: Setting default weight (1) for SRV record`);
          record.weight = 1;
        }
        if (record.port === undefined) {
          logger.trace(`CloudflareAPI.validateRecord: Port is missing for SRV record`);
          throw new Error('Port is required for SRV records');
        }
        break;
        
      case 'CAA':
        if (!record.content) {
          logger.trace(`CloudflareAPI.validateRecord: Value is missing for CAA record`);
          throw new Error('Value is required for CAA records');
        }
        if (record.flags === undefined) {
          logger.trace(`CloudflareAPI.validateRecord: Setting default flags (0) for CAA record`);
          record.flags = 0;
        }
        if (!record.tag) {
          logger.trace(`CloudflareAPI.validateRecord: Tag is missing for CAA record`);
          throw new Error('Tag is required for CAA records');
        }
        break;
        
      default:
        logger.warn(`Record type ${record.type} may not be fully supported`);
        logger.trace(`CloudflareAPI.validateRecord: Unknown record type: ${record.type}`);
    }
    
    // Proxied is only valid for certain record types
    if (record.proxied && !['A', 'AAAA', 'CNAME'].includes(record.type)) {
      logger.warn(`'proxied' is not valid for ${record.type} records. Setting to false.`);
      logger.trace(`CloudflareAPI.validateRecord: Setting proxied=false for ${record.type} record (not supported)`);
      record.proxied = false;
    }
    
    logger.trace(`CloudflareAPI.validateRecord: Record validation successful`);
  }
}

module.exports = CloudflareAPI;