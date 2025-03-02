/**
 * Cloudflare API client for DNS management
 * Includes DNS record caching to reduce API calls
 */
const axios = require('axios');
const logger = require('./logger');

class CloudflareAPI {
  constructor(config) {
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
    
    this.client = axios.create({
      baseURL: 'https://api.cloudflare.com/client/v4',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
  }
  
  /**
   * Initialize API by fetching zone ID
   */
  async init() {
    try {
      // Look up zone ID
      const response = await this.client.get('/zones', {
        params: { name: this.zone }
      });
      
      if (response.data.result.length === 0) {
        throw new Error(`Zone not found: ${this.zone}`);
      }
      
      this.zoneId = response.data.result[0].id;
      logger.debug(`Cloudflare zone ID for ${this.zone}: ${this.zoneId}`);
      logger.success('Cloudflare zone authenticated successfully');
      
      // Initialize the DNS record cache
      await this.refreshRecordCache();
      
      return true;
    } catch (error) {
      logger.error(`Failed to initialize Cloudflare API: ${error.message}`);
      throw new Error(`Failed to initialize Cloudflare API: ${error.message}`);
    }
  }
  
  /**
   * Refresh the DNS record cache
   */
  async refreshRecordCache() {
    try {
      logger.debug('Refreshing DNS record cache from Cloudflare');
      
      if (!this.zoneId) {
        await this.init();
        return;
      }
      
      // Get all records for the zone in one API call
      const response = await this.client.get(`/zones/${this.zoneId}/dns_records`, {
        params: { per_page: 100 } // Get as many records as possible in one request
      });
      
      this.recordCache = {
        records: response.data.result,
        lastUpdated: Date.now()
      };
      
      logger.debug(`Cached ${this.recordCache.records.length} DNS records from Cloudflare`);
      
      // If there are more records (pagination), fetch them as well
      let nextPage = response.data.result_info?.next_page_url;
      while (nextPage) {
        logger.debug(`Fetching additional DNS records page from Cloudflare`);
        const pageResponse = await axios.get(nextPage, {
          headers: this.client.defaults.headers
        });
        
        this.recordCache.records = [
          ...this.recordCache.records,
          ...pageResponse.data.result
        ];
        
        nextPage = pageResponse.data.result_info?.next_page_url;
      }
      
      logger.debug(`DNS record cache now contains ${this.recordCache.records.length} records`);
      
      return this.recordCache.records;
    } catch (error) {
      logger.error(`Failed to refresh DNS record cache: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get records from cache, refreshing if necessary
   */
  async getRecordsFromCache(forceRefresh = false) {
    // Check if cache is stale or if force refresh is requested
    const cacheAge = Date.now() - this.recordCache.lastUpdated;
    if (forceRefresh || cacheAge > this.cacheRefreshInterval || this.recordCache.records.length === 0) {
      await this.refreshRecordCache();
    }
    
    return this.recordCache.records;
  }
  
  /**
   * Find a record in the cache
   */
  findRecordInCache(type, name) {
    return this.recordCache.records.find(
      record => record.type === type && record.name === name
    );
  }
  
  /**
   * Update a record in the cache
   */
  updateRecordInCache(record) {
    const index = this.recordCache.records.findIndex(
      r => r.id === record.id
    );
    
    if (index !== -1) {
      this.recordCache.records[index] = record;
    } else {
      this.recordCache.records.push(record);
    }
  }
  
  /**
   * Remove a record from the cache
   */
  removeRecordFromCache(id) {
    this.recordCache.records = this.recordCache.records.filter(
      record => record.id !== id
    );
  }
  
  /**
   * List DNS records with optional filtering
   * Uses cache when possible, falls back to API if necessary
   */
  async listRecords(params = {}) {
    try {
      // If specific filters are used other than type and name, bypass cache
      const bypassCache = Object.keys(params).some(
        key => !['type', 'name'].includes(key)
      );
      
      if (bypassCache) {
        logger.debug('Bypassing cache due to complex filters');
        
        if (!this.zoneId) {
          await this.init();
        }
        
        const response = await this.client.get(`/zones/${this.zoneId}/dns_records`, {
          params
        });
        
        return response.data.result;
      }
      
      // Use cache for simple type/name filtering
      const records = await this.getRecordsFromCache();
      
      // Apply filters
      return records.filter(record => {
        let match = true;
        
        if (params.type && record.type !== params.type) {
          match = false;
        }
        
        if (params.name && record.name !== params.name) {
          match = false;
        }
        
        return match;
      });
    } catch (error) {
      logger.error(`Failed to list DNS records: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Create a new DNS record
   */
  async createRecord(record) {
    try {
      if (!this.zoneId) {
        await this.init();
      }
      
      // Add management comment
      const recordWithComment = {
        ...record,
        comment: 'Managed by Traefik DNS Manager'
      };
      
      const response = await this.client.post(
        `/zones/${this.zoneId}/dns_records`,
        recordWithComment
      );
      
      // Update the cache with the new record
      this.updateRecordInCache(response.data.result);
      
      logger.success(`Created ${record.type} record for ${record.name}`);
      
      // Update stats counter if available
      if (global.statsCounter) {
        global.statsCounter.created++;
      }
      
      return response.data.result;
    } catch (error) {
      logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update an existing DNS record
   */
  async updateRecord(id, record) {
    try {
      if (!this.zoneId) {
        await this.init();
      }
      
      // Add management comment
      const recordWithComment = {
        ...record,
        comment: 'Managed by Traefik DNS Manager'
      };
      
      const response = await this.client.put(
        `/zones/${this.zoneId}/dns_records/${id}`,
        recordWithComment
      );
      
      // Update the cache
      this.updateRecordInCache(response.data.result);
      
      logger.success(`Updated ${record.type} record for ${record.name}`);
      
      // Update stats counter if available
      if (global.statsCounter) {
        global.statsCounter.updated++;
      }
      
      return response.data.result;
    } catch (error) {
      logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Delete a DNS record
   */
  async deleteRecord(id) {
    try {
      if (!this.zoneId) {
        await this.init();
      }
      
      await this.client.delete(`/zones/${this.zoneId}/dns_records/${id}`);
      
      // Update the cache
      this.removeRecordFromCache(id);
      
      logger.debug(`Deleted DNS record with ID ${id}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete DNS record with ID ${id}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Batch process multiple DNS records at once
   * This significantly reduces API calls by processing all changes together
   */
  async batchEnsureRecords(recordConfigs) {
    if (!recordConfigs || recordConfigs.length === 0) {
      return [];
    }
    
    logger.debug(`Batch processing ${recordConfigs.length} DNS records`);
    
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
      for (const recordConfig of recordConfigs) {
        try {
          // Handle apex domains that need IP lookup
          if ((recordConfig.needsIpLookup || recordConfig.content === 'pending') && recordConfig.type === 'A') {
            // Get public IP asynchronously
            const ip = await this.config.getPublicIP();
            if (ip) {
              recordConfig.content = ip;
              logger.debug(`Retrieved public IP for apex domain ${recordConfig.name}: ${ip}`);
            } else {
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
            // Check if update is needed
            if (this.recordNeedsUpdate(existing, recordConfig)) {
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
              }
            }
          } else {
            // Need to create a new record
            pendingChanges.create.push({
              record: recordConfig
            });
          }
        } catch (error) {
          logger.error(`Error processing ${recordConfig.name}: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Second pass: apply all changes
      logger.debug(`DNS changes: ${pendingChanges.create.length} to create, ${pendingChanges.update.length} to update, ${pendingChanges.unchanged.length} unchanged`);
      
      // Create new records
      for (const { record } of pendingChanges.create) {
        try {
          const result = await this.createRecord(record);
          results.push(result);
        } catch (error) {
          logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Update existing records
      for (const { id, record } of pendingChanges.update) {
        try {
          const result = await this.updateRecord(id, record);
          results.push(result);
        } catch (error) {
          logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
          }
        }
      }
      
      // Add unchanged records to results too
      for (const { existing } of pendingChanges.unchanged) {
        results.push(existing);
      }
      
      return results;
    } catch (error) {
      logger.error(`Failed to batch process DNS records: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Ensure a DNS record exists and is up to date
   * This is the legacy method for ensuring a single record
   * For better performance, use batchEnsureRecords instead
   */
  async ensureRecord(record) {
    try {
      // Handle apex domains that need IP lookup
      if ((record.needsIpLookup || record.content === 'pending') && record.type === 'A') {
        // Get public IP asynchronously
        const ip = await this.config.getPublicIP();
        if (ip) {
          record.content = ip;
          logger.debug(`Retrieved public IP for apex domain ${record.name}: ${ip}`);
        } else {
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
        // Check if update is needed
        if (this.recordNeedsUpdate(existingFromCache, record)) {
          return await this.updateRecord(existingFromCache.id, record);
        }
        
        logger.debug(`${record.type} record for ${record.name} already up to date`);
        
        // Update stats counter if available
        if (global.statsCounter) {
          global.statsCounter.upToDate++;
        }
        
        return existingFromCache;
      } else {
        // Create new record
        return await this.createRecord(record);
      }
    } catch (error) {
      logger.error(`Failed to ensure record for ${record.name}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Check if a record needs to be updated
   */
  recordNeedsUpdate(existing, newRecord) {
    // Basic field comparison
    let needsUpdate = (
      existing.content !== newRecord.content ||
      existing.ttl !== newRecord.ttl
    );
    
    // Only compare proxied for supported record types
    if (['A', 'AAAA', 'CNAME'].includes(newRecord.type)) {
      needsUpdate = needsUpdate || (existing.proxied !== newRecord.proxied);
    }
    
    // Type-specific field comparisons
    switch (newRecord.type) {
      case 'MX':
        needsUpdate = needsUpdate || (existing.priority !== newRecord.priority);
        break;
        
      case 'SRV':
        needsUpdate = needsUpdate || 
          (existing.priority !== newRecord.priority) ||
          (existing.weight !== newRecord.weight) ||
          (existing.port !== newRecord.port);
        break;
        
      case 'CAA':
        needsUpdate = needsUpdate || 
          (existing.flags !== newRecord.flags) ||
          (existing.tag !== newRecord.tag);
        break;
    }
    
    return needsUpdate;
  }
  
  /**
   * Validate a record configuration
   */
  validateRecord(record) {
    // Common validations
    if (!record.type) {
      throw new Error('Record type is required');
    }
    
    if (!record.name) {
      throw new Error('Record name is required');
    }
    
    // Type-specific validations
    switch (record.type) {
      case 'A':
        if (!record.content) {
          throw new Error('IP address is required for A records');
        }
        break;
        
      case 'AAAA':
        if (!record.content) {
          throw new Error('IPv6 address is required for AAAA records');
        }
        break;
        
      case 'CNAME':
      case 'TXT':
      case 'NS':
        if (!record.content) {
          throw new Error(`Content is required for ${record.type} records`);
        }
        break;
        
      case 'MX':
        if (!record.content) {
          throw new Error('Mail server is required for MX records');
        }
        // Set default priority if missing
        if (record.priority === undefined) {
          record.priority = 10;
        }
        break;
        
      case 'SRV':
        if (!record.content) {
          throw new Error('Target is required for SRV records');
        }
        // Set defaults for SRV fields
        if (record.priority === undefined) record.priority = 1;
        if (record.weight === undefined) record.weight = 1;
        if (record.port === undefined) {
          throw new Error('Port is required for SRV records');
        }
        break;
        
      case 'CAA':
        if (!record.content) {
          throw new Error('Value is required for CAA records');
        }
        if (record.flags === undefined) record.flags = 0;
        if (!record.tag) {
          throw new Error('Tag is required for CAA records');
        }
        break;
        
      default:
        logger.warn(`Record type ${record.type} may not be fully supported`);
    }
    
    // Proxied is only valid for certain record types
    if (record.proxied && !['A', 'AAAA', 'CNAME'].includes(record.type)) {
      logger.warn(`'proxied' is not valid for ${record.type} records. Setting to false.`);
      record.proxied = false;
    }
  }
}

module.exports = CloudflareAPI;