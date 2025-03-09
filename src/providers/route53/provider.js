/**
 * AWS Route53 DNS Provider
 * Core implementation of the DNSProvider interface for AWS Route53
 */
const axios = require('axios');
const AWS = require('aws-sdk');
const DNSProvider = require('../base');
const logger = require('../../utils/logger');
const { convertToRoute53Format } = require('./converter');
const { validateRecord } = require('./validator');

class Route53Provider extends DNSProvider {
  constructor(config) {
    super(config);
    
    logger.trace('Route53Provider.constructor: Initialising with config');
    
    // Get credentials from config
    this.accessKey = config.route53AccessKey;
    this.secretKey = config.route53SecretKey;
    this.zone = config.route53Zone;
    this.zoneId = config.route53ZoneId; // May be null if not specified in config
    
    // Initialise AWS SDK
    AWS.config.update({
      accessKeyId: this.accessKey,
      secretAccessKey: this.secretKey,
      region: config.route53Region || 'eu-west-2' // Default to eu-west-2 if not specified
    });
    
    // Create Route53 service
    this.route53 = new AWS.Route53();
    
    logger.trace('Route53Provider.constructor: AWS Route53 client initialised');
  }
  
  /**
   * Initialise API by fetching hosted zone ID if not provided
   */
  async init() {
    logger.trace(`Route53Provider.init: Starting initialization for zone "${this.zone}"`);
    
    try {
      // If zoneId is not provided in config, look it up
      if (!this.zoneId) {
        logger.trace('Route53Provider.init: No zoneId provided, looking up from zone name');
        
        // Make sure the zone name has a trailing dot which Route53 requires
        const zoneName = this.zone.endsWith('.') ? this.zone : `${this.zone}.`;
        
        const params = {
          DNSName: zoneName
        };
        
        const response = await this.route53.listHostedZonesByName(params).promise();
        logger.trace(`Route53Provider.init: Received ${response.HostedZones.length} zones from API`);
        
        // Find the exact matching zone
        const matchingZone = response.HostedZones.find(
          zone => zone.Name === zoneName
        );
        
        if (!matchingZone) {
          logger.trace(`Route53Provider.init: Zone "${this.zone}" not found in Route53`);
          throw new Error(`Zone not found: ${this.zone}`);
        }
        
        // Extract the zoneId (removing the /hostedzone/ prefix)
        this.zoneId = matchingZone.Id.replace(/^\/hostedzone\//, '');
        logger.debug(`Route53 zoneId for ${this.zone}: ${this.zoneId}`);
      }
      
      logger.success('Route53 zone authenticated successfully');
      
      // Initialise the DNS record cache
      logger.trace('Route53Provider.init: Initialising DNS record cache');
      await this.refreshRecordCache();
      
      return true;
    } catch (error) {
      logger.error(`Failed to initialise Route53 API: ${error.message}`);
      logger.trace(`Route53Provider.init: Error details: ${JSON.stringify(error)}`);
      throw new Error(`Failed to initialise Route53 API: ${error.message}`);
    }
  }
  
  /**
   * Refresh the DNS record cache
   */
  async refreshRecordCache() {
    logger.trace('Route53Provider.refreshRecordCache: Starting cache refresh');
    
    try {
      logger.debug('Refreshing DNS record cache from Route53');
      
      if (!this.zoneId) {
        logger.trace('Route53Provider.refreshRecordCache: No zoneId, initialising first');
        await this.init();
        return;
      }
      
      // Get all records for the zone
      const records = await this.fetchAllRecords();
      const oldRecordCount = this.recordCache.records.length;
      
      this.recordCache = {
        records: records,
        lastUpdated: Date.now()
      };
      
      logger.debug(`Cached ${this.recordCache.records.length} DNS records from Route53`);
      logger.trace(`Route53Provider.refreshRecordCache: Cache updated from ${oldRecordCount} to ${this.recordCache.records.length} records`);
      
      // In TRACE mode, output the entire cache for debugging
      if (logger.level >= 4) { // TRACE level
        logger.trace('Route53Provider.refreshRecordCache: Current cache contents:');
        this.recordCache.records.forEach((record, index) => {
          logger.trace(`Record[${index}]: type=${record.type}, name=${record.name}, value=${record.value}`);
        });
      }
      
      return this.recordCache.records;
    } catch (error) {
      logger.error(`Failed to refresh DNS record cache: ${error.message}`);
      logger.trace(`Route53Provider.refreshRecordCache: Error details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

/**
   * Fetch all records from Route53, handling pagination
   */
async fetchAllRecords() {
  let allRecords = [];
  let isTruncated = true;
  let nextRecordName = null;
  let nextRecordType = null;
  let nextRecordIdentifier = null;
  
  while (isTruncated) {
    try {
      const params = {
        HostedZoneId: this.zoneId
      };
      
      // Handle pagination
      if (nextRecordName) {
        params.StartRecordName = nextRecordName;
        params.StartRecordType = nextRecordType;
        
        if (nextRecordIdentifier) {
          params.StartRecordIdentifier = nextRecordIdentifier;
        }
      }
      
      const response = await this.route53.listResourceRecordSets(params).promise();
      
      // Process and standardize records
      const standardizedRecords = this.standardizeRecords(response.ResourceRecordSets);
      allRecords = allRecords.concat(standardizedRecords);
      
      // Check if there are more records to fetch
      isTruncated = response.IsTruncated;
      
      if (isTruncated) {
        nextRecordName = response.NextRecordName;
        nextRecordType = response.NextRecordType;
        nextRecordIdentifier = response.NextRecordIdentifier;
      }
    } catch (error) {
      logger.error(`Error fetching DNS records: ${error.message}`);
      throw error;
    }
  }
  
  return allRecords;
}

/**
 * Standardize Route53 records to internal format
 */
standardizeRecords(route53Records) {
  return route53Records.map(record => {
    // Create a standardized record with common fields
    const standardRecord = {
      id: `${record.Name}:${record.Type}`, // Route53 doesn't have record IDs, create a composite key
      type: record.Type,
      name: record.Name.endsWith('.') ? record.Name.slice(0, -1) : record.Name,
      ttl: record.TTL || 300
    };
    
    // Process resource records based on type
    if (record.ResourceRecords && record.ResourceRecords.length > 0) {
      // For most record types with simple values
      if (['A', 'AAAA', 'CNAME', 'TXT', 'NS'].includes(record.Type)) {
        standardRecord.content = record.ResourceRecords[0].Value;
        
        // For TXT records, remove quotes if present
        if (record.Type === 'TXT' && standardRecord.content.startsWith('"') && standardRecord.content.endsWith('"')) {
          standardRecord.content = standardRecord.content.slice(1, -1);
        }
      } 
      // For MX records, extract priority and content
      else if (record.Type === 'MX') {
        const parts = record.ResourceRecords[0].Value.split(' ');
        standardRecord.priority = parseInt(parts[0], 10);
        standardRecord.content = parts.slice(1).join(' ');
      }
      // For SRV records, parse the complex format
      else if (record.Type === 'SRV') {
        const parts = record.ResourceRecords[0].Value.split(' ');
        standardRecord.priority = parseInt(parts[0], 10);
        standardRecord.weight = parseInt(parts[1], 10);
        standardRecord.port = parseInt(parts[2], 10);
        standardRecord.content = parts[3];
      }
      // For CAA records, extract flags, tag, and value
      else if (record.Type === 'CAA') {
        const parts = record.ResourceRecords[0].Value.split(' ');
        standardRecord.flags = parseInt(parts[0], 10);
        standardRecord.tag = parts[1].replace(/"/g, '');
        standardRecord.content = parts[2].replace(/"/g, '');
      }
    }
    // Handle alias records
    else if (record.AliasTarget) {
      standardRecord.content = record.AliasTarget.DNSName;
      standardRecord.isAlias = true;
      standardRecord.aliasTarget = {
        hostedZoneId: record.AliasTarget.HostedZoneId,
        dnsName: record.AliasTarget.DNSName,
        evaluateTargetHealth: record.AliasTarget.EvaluateTargetHealth
      };
    }
    
    return standardRecord;
  });
}

/**
 * Update a record in the cache
 */
updateRecordInCache(record) {
  logger.trace(`Route53Provider.updateRecordInCache: Updating record in cache: name=${record.name}, type=${record.type}`);
  
  const index = this.recordCache.records.findIndex(
    r => r.name === record.name && r.type === record.type
  );
  
  if (index !== -1) {
    logger.trace(`Route53Provider.updateRecordInCache: Found existing record at index ${index}, replacing`);
    this.recordCache.records[index] = record;
  } else {
    logger.trace(`Route53Provider.updateRecordInCache: Record not found in cache, adding new record`);
    this.recordCache.records.push(record);
  }
}

/**
 * Remove a record from the cache
 */
removeRecordFromCache(name, type) {
  logger.trace(`Route53Provider.removeRecordFromCache: Removing record name=${name}, type=${type} from cache`);
  
  const initialLength = this.recordCache.records.length;
  this.recordCache.records = this.recordCache.records.filter(
    record => !(record.name === name && record.type === type)
  );
  
  const removed = initialLength - this.recordCache.records.length;
  logger.trace(`Route53Provider.removeRecordFromCache: Removed ${removed} records from cache`);
}

/**
 * List DNS records with optional filtering
 */
async listRecords(params = {}) {
  logger.trace(`Route53Provider.listRecords: Listing records with params: ${JSON.stringify(params)}`);
  
  try {
    // If specific filters are used other than type and name, bypass cache
    const bypassCache = Object.keys(params).some(
      key => !['type', 'name'].includes(key)
    );
    
    if (bypassCache) {
      logger.debug('Bypassing cache due to complex filters');
      logger.trace(`Route53Provider.listRecords: Bypassing cache due to filters: ${JSON.stringify(params)}`);
      
      if (!this.zoneId) {
        logger.trace('Route53Provider.listRecords: No zoneId, initialising first');
        await this.init();
      }
      
      // Build Route53 params
      const route53Params = {
        HostedZoneId: this.zoneId
      };
      
      // Add type filter if specified
      if (params.type) {
        route53Params.StartRecordType = params.type;
      }
      
      // Add name filter if specified - Route53 requires trailing dot
      if (params.name) {
        const name = params.name.endsWith('.') ? params.name : `${params.name}.`;
        route53Params.StartRecordName = name;
      }
      
      // Fetch records from Route53
      const response = await this.route53.listResourceRecordSets(route53Params).promise();
      const allRecords = this.standardizeRecords(response.ResourceRecordSets);
      
      // Apply filters manually since Route53 API has limited filtering
      const filteredRecords = allRecords.filter(record => {
        let match = true;
        
        if (params.type && record.type !== params.type) {
          match = false;
        }
        
        if (params.name) {
          // Normalize names for comparison (remove trailing dots)
          const recordName = record.name.endsWith('.') ? record.name.slice(0, -1) : record.name;
          const paramName = params.name.endsWith('.') ? params.name.slice(0, -1) : params.name;
          
          if (recordName !== paramName) {
            match = false;
          }
        }
        
        return match;
      });
      
      logger.trace(`Route53Provider.listRecords: API filtering returned ${filteredRecords.length} records`);
      return filteredRecords;
    }
    
    // Use cache for simple type/name filtering
    logger.trace('Route53Provider.listRecords: Using cache with filters');
    const records = await this.getRecordsFromCache();
    
    // Apply filters
    const filteredRecords = records.filter(record => {
      let match = true;
      
      if (params.type && record.type !== params.type) {
        match = false;
      }
      
      if (params.name) {
        // Normalize names for comparison (remove trailing dots)
        const recordName = record.name.endsWith('.') ? record.name.slice(0, -1) : record.name;
        const paramName = params.name.endsWith('.') ? params.name.slice(0, -1) : params.name;
        
        if (recordName !== paramName) {
          match = false;
        }
      }
      
      return match;
    });
    
    logger.trace(`Route53Provider.listRecords: Cache filtering returned ${filteredRecords.length} records`);
    
    return filteredRecords;
  } catch (error) {
    logger.error(`Failed to list DNS records: ${error.message}`);
    logger.trace(`Route53Provider.listRecords: Error details: ${JSON.stringify(error)}`);
    throw error;
  }
}

/**
   * Find a record in the cache
   * Override to handle Route53's trailing dots in names
   */
findRecordInCache(type, name) {
  // Normalize the name (remove trailing dot if present)
  const normalizedName = name.endsWith('.') ? name.slice(0, -1) : name;
  
  logger.trace(`Route53Provider.findRecordInCache: Looking for ${type} record with name ${normalizedName}`);
  
  // Find in cache
  const record = this.recordCache.records.find(r => {
    // Normalize record name as well
    const recordName = r.name.endsWith('.') ? r.name.slice(0, -1) : r.name;
    return r.type === type && recordName === normalizedName;
  });
  
  if (record) {
    logger.trace(`Route53Provider.findRecordInCache: Found record with name ${record.name}`);
    return record;
  }
  
  logger.trace(`Route53Provider.findRecordInCache: No record found`);
  return null;
}

/**
 * Create a new DNS record
 */
async createRecord(record) {
  logger.trace(`Route53Provider.createRecord: Creating record type=${record.type}, name=${record.name}, content=${record.content}`);
  
  try {
    // Validate the record first
    validateRecord(record);
    
    // Make sure we have zoneId
    if (!this.zoneId) {
      logger.trace('Route53Provider.createRecord: No zoneId, initialising first');
      await this.init();
    }
    
    // Convert to Route53 format
    const changeData = convertToRoute53Format(record, this.zone);
    
    // Create the change batch
    const params = {
      HostedZoneId: this.zoneId,
      ChangeBatch: {
        Comment: 'Created by TráfegoDNS',
        Changes: [
          {
            Action: 'CREATE',
            ResourceRecordSet: changeData
          }
        ]
      }
    };
    
    logger.trace(`Route53Provider.createRecord: Sending change request to Route53: ${JSON.stringify(params)}`);
    
    // Submit the change
    const response = await this.route53.changeResourceRecordSets(params).promise();
    
    // Create a standardized record for caching
    const createdRecord = {
      id: `${record.name}:${record.type}`,
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl
    };
    
    // Add type-specific fields
    if (record.type === 'MX') {
      createdRecord.priority = record.priority;
    } else if (record.type === 'SRV') {
      createdRecord.priority = record.priority;
      createdRecord.weight = record.weight;
      createdRecord.port = record.port;
    } else if (record.type === 'CAA') {
      createdRecord.flags = record.flags;
      createdRecord.tag = record.tag;
    }
    
    // Update the cache with the new record
    this.updateRecordInCache(createdRecord);
    
    // Log at INFO level which record was created
    logger.info(`✨ Created ${record.type} record for ${record.name}`);
    logger.success(`Created ${record.type} record for ${record.name}`);
    
    // Update stats counter if available
    if (global.statsCounter) {
      global.statsCounter.created++;
      logger.trace(`Route53Provider.createRecord: Incremented global.statsCounter.created to ${global.statsCounter.created}`);
    }
    
    return createdRecord;
  } catch (error) {
    logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
    logger.trace(`Route53Provider.createRecord: Error details: ${JSON.stringify(error)}`);
    throw error;
  }
}

/**
 * Update an existing DNS record
 * Note: Route53 doesn't have a direct update method, we have to delete and create
 */
async updateRecord(id, record) {
  logger.trace(`Route53Provider.updateRecord: Updating record ID=${id}, type=${record.type}, name=${record.name}, content=${record.content}`);
  
  try {
    // Parse the id to get name and type (Route53 has no actual record IDs)
    let recordName, recordType;
    
    if (id.includes(':')) {
      // If ID is in our composite format "name:type"
      [recordName, recordType] = id.split(':');
    } else {
      // Otherwise assume id is just name and type comes from record
      recordName = id;
      recordType = record.type;
    }
    
    // Validate the record first
    validateRecord(record);
    
    // Make sure we have zoneId
    if (!this.zoneId) {
      logger.trace('Route53Provider.updateRecord: No zoneId, initialising first');
      await this.init();
    }
    
    // First, find the existing record to delete
    const existing = await this.findRecordInCache(recordType, recordName);
    
    if (!existing) {
      throw new Error(`Record ${recordName} (${recordType}) not found for update`);
    }
    
    // Convert to Route53 format for both the old and new record
    const oldRecord = convertToRoute53Format(existing, this.zone);
    const newRecord = convertToRoute53Format(record, this.zone);
    
    // Create the change batch for deleting old and creating new
    const params = {
      HostedZoneId: this.zoneId,
      ChangeBatch: {
        Comment: 'Updated by TráfegoDNS',
        Changes: [
          {
            Action: 'DELETE',
            ResourceRecordSet: oldRecord
          },
          {
            Action: 'CREATE',
            ResourceRecordSet: newRecord
          }
        ]
      }
    };
    
    logger.trace(`Route53Provider.updateRecord: Sending change request to Route53: ${JSON.stringify(params)}`);
    
    // Submit the change
    const response = await this.route53.changeResourceRecordSets(params).promise();
    
    // Create a standardized record for caching
    const updatedRecord = {
      id: `${record.name}:${record.type}`,
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl
    };
    
    // Add type-specific fields
    if (record.type === 'MX') {
      updatedRecord.priority = record.priority;
    } else if (record.type === 'SRV') {
      updatedRecord.priority = record.priority;
      updatedRecord.weight = record.weight;
      updatedRecord.port = record.port;
    } else if (record.type === 'CAA') {
      updatedRecord.flags = record.flags;
      updatedRecord.tag = record.tag;
    }
    
    // Update the cache
    this.updateRecordInCache(updatedRecord);
    
    // Log at INFO level which record was updated
    logger.info(`📝 Updated ${record.type} record for ${record.name}`);
    logger.success(`Updated ${record.type} record for ${record.name}`);
    
    // Update stats counter if available
    if (global.statsCounter) {
      global.statsCounter.updated++;
      logger.trace(`Route53Provider.updateRecord: Incremented global.statsCounter.updated to ${global.statsCounter.updated}`);
    }
    
    return updatedRecord;
  } catch (error) {
    logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
    logger.trace(`Route53Provider.updateRecord: Error details: ${JSON.stringify(error)}`);
    throw error;
  }
}

/**
 * Delete a DNS record
 */
async deleteRecord(id) {
  logger.trace(`Route53Provider.deleteRecord: Deleting record ID=${id}`);
  
  try {
    // Parse the id to get name and type
    let recordName, recordType;
    
    if (id.includes(':')) {
      [recordName, recordType] = id.split(':');
    } else {
      // If id is not in expected format, try to find record in cache
      const record = this.recordCache.records.find(r => r.id === id);
      if (record) {
        recordName = record.name;
        recordType = record.type;
      } else {
        throw new Error(`Record with ID ${id} not found for deletion`);
      }
    }
    
    // Make sure we have zoneId
    if (!this.zoneId) {
      logger.trace('Route53Provider.deleteRecord: No zoneId, initialising first');
      await this.init();
    }
    
    // Find the existing record to delete
    const existing = await this.findRecordInCache(recordType, recordName);
    
    if (!existing) {
      throw new Error(`Record ${recordName} (${recordType}) not found for deletion`);
    }
    
    // Find the record in cache before deleting to log info
    const recordToDelete = existing;
    if (recordToDelete) {
      logger.info(`🗑️ Deleting DNS record: ${recordToDelete.name} (${recordToDelete.type})`);
    }
    
    // Convert to Route53 format
    const route53Record = convertToRoute53Format(existing, this.zone);
    
    // Create the change batch
    const params = {
      HostedZoneId: this.zoneId,
      ChangeBatch: {
        Comment: 'Deleted by TráfegoDNS',
        Changes: [
          {
            Action: 'DELETE',
            ResourceRecordSet: route53Record
          }
        ]
      }
    };
    
    logger.trace(`Route53Provider.deleteRecord: Sending delete request to Route53: ${JSON.stringify(params)}`);
    
    // Submit the change
    await this.route53.changeResourceRecordSets(params).promise();
    
    // Update the cache
    this.removeRecordFromCache(recordName, recordType);
    
    logger.debug(`Deleted DNS record: ${recordName} (${recordType})`);
    logger.trace(`Route53Provider.deleteRecord: Record deletion successful`);
    
    return true;
  } catch (error) {
    logger.error(`Failed to delete DNS record with ID ${id}: ${error.message}`);
    logger.trace(`Route53Provider.deleteRecord: Error details: ${JSON.stringify(error)}`);
    throw error;
  }
}

  /**
   * Batch process multiple DNS records at once
   * Route53 supports batching changes in a single API call, which is more efficient
   */
  async batchEnsureRecords(recordConfigs) {
    if (!recordConfigs || recordConfigs.length === 0) {
      logger.trace('Route53Provider.batchEnsureRecords: No record configs provided, skipping');
      return [];
    }
    
    logger.debug(`Batch processing ${recordConfigs.length} DNS records`);
    logger.trace(`Route53Provider.batchEnsureRecords: Starting batch processing of ${recordConfigs.length} records`);
    
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
      logger.trace('Route53Provider.batchEnsureRecords: First pass - examining records');
      
      for (const recordConfig of recordConfigs) {
        try {
          logger.trace(`Route53Provider.batchEnsureRecords: Processing record ${recordConfig.name} (${recordConfig.type})`);
          
          // Skip records with proxied flag (Route53 doesn't support proxying)
          if (recordConfig.proxied !== undefined) {
            logger.debug(`Route53 doesn't support proxying, ignoring proxied flag for ${recordConfig.name}`);
            delete recordConfig.proxied;
          }
          
          // Handle apex domains that need IP lookup
          if ((recordConfig.needsIpLookup || recordConfig.content === 'pending') && recordConfig.type === 'A') {
            logger.trace(`Route53Provider.batchEnsureRecords: Record needs IP lookup: ${recordConfig.name}`);
            
            // Get public IP asynchronously
            const ip = await this.config.getPublicIP();
            if (ip) {
              logger.trace(`Route53Provider.batchEnsureRecords: Retrieved IP address: ${ip}`);
              recordConfig.content = ip;
              logger.debug(`Retrieved public IP for apex domain ${recordConfig.name}: ${ip}`);
            } else {
              logger.trace(`Route53Provider.batchEnsureRecords: Failed to retrieve IP address`);
              throw new Error(`Unable to determine public IP for apex domain A record: ${recordConfig.name}`);
            }
            // Remove the flag to avoid confusion
            delete recordConfig.needsIpLookup;
          }
          
          // Validate the record
          validateRecord(recordConfig);
          
          // Ensure record name is properly formatted for Route53 (always ends with dot)
          if (!recordConfig.name.endsWith('.')) {
            // Append the zone name if not already present
            if (!recordConfig.name.endsWith(this.zone)) {
              // For apex domain
              if (recordConfig.name === this.zone.replace(/\.$/, '')) {
                recordConfig.name = this.zone.endsWith('.') ? this.zone : `${this.zone}.`;
              } else {
                // For subdomains
                const zoneName = this.zone.endsWith('.') ? this.zone : `${this.zone}.`;
                recordConfig.name = `${recordConfig.name}.${zoneName}`;
              }
            } else {
              // Already has the zone but missing the trailing dot
              recordConfig.name = `${recordConfig.name}.`;
            }
          }
          
          // Find existing record in cache
          const existing = this.findRecordInCache(recordConfig.type, recordConfig.name);
          
          if (existing) {
            logger.trace(`Route53Provider.batchEnsureRecords: Found existing record name=${existing.name}`);
            
            // Check if update is needed
            const needsUpdate = this.recordNeedsUpdate(existing, recordConfig);
            logger.trace(`Route53Provider.batchEnsureRecords: Record ${recordConfig.name} needs update: ${needsUpdate}`);
            
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
                logger.trace(`Route53Provider.batchEnsureRecords: Incremented global.statsCounter.upToDate to ${global.statsCounter.upToDate}`);
              }
            }
          } else {
            logger.trace(`Route53Provider.batchEnsureRecords: No existing record found, needs creation`);
            
            // Need to create a new record
            pendingChanges.create.push({
              record: recordConfig
            });
          }
        } catch (error) {
          logger.error(`Error processing ${recordConfig.name}: ${error.message}`);
          logger.trace(`Route53Provider.batchEnsureRecords: Error details: ${error.message}`);
          
          if (global.statsCounter) {
            global.statsCounter.errors++;
            logger.trace(`Route53Provider.batchEnsureRecords: Incremented global.statsCounter.errors to ${global.statsCounter.errors}`);
          }
        }
      }
      
      // Second pass: apply all changes
      logger.debug(`DNS changes: ${pendingChanges.create.length} to create, ${pendingChanges.update.length} to update, ${pendingChanges.unchanged.length} unchanged`);
      logger.trace('Route53Provider.batchEnsureRecords: Second pass - applying changes');
      
      // For Route53, we can batch multiple changes in a single API call
      // But we need to be careful not to exceed AWS API limits (max 1000 changes per batch)
      const MAX_CHANGES_PER_BATCH = 100; // Set conservatively below Route53's limit
      
      // Process creates and updates in batches
      if (pendingChanges.create.length > 0 || pendingChanges.update.length > 0) {
        // Combine all creates and updates into a single array of changes
        const allChanges = [];
        
  // Add creates
  for (const { record } of pendingChanges.create) {
    allChanges.push({
      Action: 'CREATE',
      ResourceRecordSet: convertToRoute53Format(record, this.zone)
    });
  }

  // Add updates (which are DELETE + CREATE in Route53)
  for (const { existing, record } of pendingChanges.update) {
    // Need to delete the old record first
    allChanges.push({
      Action: 'DELETE',
      ResourceRecordSet: convertToRoute53Format(existing, this.zone)
    });
    
    // Then create the new version
    allChanges.push({
      Action: 'CREATE',
      ResourceRecordSet: convertToRoute53Format(record, this.zone)
    });
  }

  // Split changes into batches
  const changeBatches = [];
  for (let i = 0; i < allChanges.length; i += MAX_CHANGES_PER_BATCH) {
    changeBatches.push(allChanges.slice(i, i + MAX_CHANGES_PER_BATCH));
  }

  logger.debug(`Splitting ${allChanges.length} Route53 changes into ${changeBatches.length} batches`);

  // Process each batch
  for (let i = 0; i < changeBatches.length; i++) {
    const changes = changeBatches[i];
    logger.debug(`Processing Route53 change batch ${i+1}/${changeBatches.length} with ${changes.length} changes`);
    
    const params = {
      HostedZoneId: this.zoneId,
      ChangeBatch: {
        Comment: 'Batch update by TráfegoDNS',
        Changes: changes
      }
    };
    
    try {
      await this.route53.changeResourceRecordSets(params).promise();
      logger.debug(`Successfully submitted batch ${i+1}/${changeBatches.length}`);
    } catch (error) {
      logger.error(`Error submitting Route53 change batch ${i+1}: ${error.message}`);
      
      // If a batch fails, we'll need to process individual changes
      logger.debug('Falling back to individual record processing');
      
      // Roll back to individual processing
      break;
    }
  }
  }

  // Fallback to individual processing if batch processing fails

  // Create new records
  for (const { record } of pendingChanges.create) {
  try {
    logger.trace(`Route53Provider.batchEnsureRecords: Creating record ${record.name} (${record.type})`);
    // Log at INFO level which record will be created
    logger.info(`✨ Creating ${record.type} record for ${record.name}`);
    const result = await this.createRecord(record);
    results.push(result);
  } catch (error) {
    logger.error(`Failed to create ${record.type} record for ${record.name}: ${error.message}`);
    logger.trace(`Route53Provider.batchEnsureRecords: Create error: ${error.message}`);
    
    if (global.statsCounter) {
      global.statsCounter.errors++;
    }
  }
}

// Update existing records
for (const { id, record } of pendingChanges.update) {
try {
  logger.trace(`Route53Provider.batchEnsureRecords: Updating record ${record.name} (${record.type})`);
  // Log at INFO level which record will be updated
  logger.info(`📝 Updating ${record.type} record for ${record.name}`);
  const result = await this.updateRecord(id, record);
  results.push(result);
} catch (error) {
  logger.error(`Failed to update ${record.type} record for ${record.name}: ${error.message}`);
  logger.trace(`Route53Provider.batchEnsureRecords: Update error: ${error.message}`);
  
  if (global.statsCounter) {
    global.statsCounter.errors++;
  }
}
}

// Add unchanged records to results too
for (const { existing } of pendingChanges.unchanged) {
results.push(existing);
}

logger.trace(`Route53Provider.batchEnsureRecords: Batch processing complete, returning ${results.length} results`);
return results;
} catch (error) {
logger.error(`Failed to batch process DNS records: ${error.message}`);
logger.trace(`Route53Provider.batchEnsureRecords: Error details: ${error.message}`);
throw error;
}
}

  /**
  * Check if a record needs to be updated
  */
  recordNeedsUpdate(existing, newRecord) {
  logger.trace(`Route53Provider.recordNeedsUpdate: Comparing records for ${newRecord.name}`);
  logger.trace(`Route53Provider.recordNeedsUpdate: Existing: ${JSON.stringify(existing)}`);
  logger.trace(`Route53Provider.recordNeedsUpdate: New: ${JSON.stringify(newRecord)}`);

  // Basic field comparison
  let needsUpdate = false;

  // Compare content/data (normalize and remove trailing dots for comparison)
  let existingContent = existing.content;
  let newContent = newRecord.content;

  // Normalize record contents for comparison
  if (existingContent && existingContent.endsWith('.')) {
  existingContent = existingContent.slice(0, -1);
  }

  if (newContent && newContent.endsWith('.')) {
  newContent = newContent.slice(0, -1);
  }

  if (existingContent !== newContent) {
  logger.trace(`Route53Provider.recordNeedsUpdate: Content different: ${existingContent} vs ${newContent}`);
  needsUpdate = true;
  }

  // Compare TTL
  if (existing.ttl !== newRecord.ttl) {
  logger.trace(`Route53Provider.recordNeedsUpdate: TTL different: ${existing.ttl} vs ${newRecord.ttl}`);
  needsUpdate = true;
  }

  // Type-specific field comparisons
  switch (newRecord.type) {
  case 'MX':
  if (existing.priority !== newRecord.priority) {
    logger.trace(`Route53Provider.recordNeedsUpdate: MX priority different: ${existing.priority} vs ${newRecord.priority}`);
    needsUpdate = true;
  }
  break;

  case 'SRV':
  if (existing.priority !== newRecord.priority ||
      existing.weight !== newRecord.weight ||
      existing.port !== newRecord.port) {
    logger.trace(`Route53Provider.recordNeedsUpdate: SRV fields different`);
    needsUpdate = true;
  }
  break;

  case 'CAA':
  if (existing.flags !== newRecord.flags ||
      existing.tag !== newRecord.tag) {
    logger.trace(`Route53Provider.recordNeedsUpdate: CAA fields different`);
    needsUpdate = true;
  }
  break;
  }

  // If an update is needed, log the specific differences at DEBUG level
  if (needsUpdate && logger.level >= 3) { // DEBUG level or higher
  logger.debug(`Record ${newRecord.name} needs update:`);
  if (existingContent !== newContent) 
  logger.debug(` - Content: ${existingContent} → ${newContent}`);
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

  logger.trace(`Route53Provider.recordNeedsUpdate: Final result - needs update: ${needsUpdate}`);
  return needsUpdate;
  }
}

module.exports = Route53Provider;