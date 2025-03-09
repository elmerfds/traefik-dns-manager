/**
 * AWS Route53 DNS Provider
 * Core implementation of the DNSProvider interface for AWS Route53
 */
const { 
  Route53Client, 
  ListHostedZonesByNameCommand, 
  ListResourceRecordSetsCommand, 
  ChangeResourceRecordSetsCommand 
} = require('@aws-sdk/client-route-53');
const DNSProvider = require('../base');
const logger = require('../../utils/logger');
const { convertToRoute53Format } = require('./converter');
const { validateRecord } = require('./validator');
const { 
  standardizeRecords, 
  recordNeedsUpdate 
} = require('./recordUtils');
const { 
  fetchAllRecords,
  findRecordInCache,
  updateRecordInCache,
  removeRecordFromCache
} = require('./cacheUtils');
const {
  createRecord,
  updateRecord,
  deleteRecord,
  batchEnsureRecords
} = require('./operationUtils');

class Route53Provider extends DNSProvider {
  constructor(config) {
    super(config);
    
    logger.trace('Route53Provider.constructor: Initialising with config');
    
    // Get credentials from config
    this.accessKey = config.route53AccessKey;
    this.secretKey = config.route53SecretKey;
    this.zone = config.route53Zone;
    this.zoneId = config.route53ZoneId; // May be null if not specified in config
    
    // Initialize AWS SDK v3 client
    this.route53 = new Route53Client({
      region: config.route53Region || 'eu-west-2', // Default to eu-west-2 if not specified
      credentials: {
        accessKeyId: this.accessKey,
        secretAccessKey: this.secretKey
      }
    });
    
    // Bind utility functions to this instance
    this.standardizeRecords = standardizeRecords.bind(this);
    this.recordNeedsUpdate = recordNeedsUpdate.bind(this);
    this.fetchAllRecords = fetchAllRecords.bind(this);
    this.findRecordInCache = findRecordInCache.bind(this);
    this.updateRecordInCache = updateRecordInCache.bind(this);
    this.removeRecordFromCache = removeRecordFromCache.bind(this);
    this.createRecord = createRecord.bind(this);
    this.updateRecord = updateRecord.bind(this);
    this.deleteRecord = deleteRecord.bind(this);
    this.batchEnsureRecords = batchEnsureRecords.bind(this);
    
    logger.trace('Route53Provider.constructor: AWS Route53 client initialised');
  }
  
  /**
   * Initialize API by fetching hosted zone ID if not provided
   */
  async init() {
    logger.trace(`Route53Provider.init: Starting initialization for zone "${this.zone}"`);
    
    try {
      // If zoneId is not provided in config, look it up
      if (!this.zoneId) {
        logger.trace('Route53Provider.init: No zoneId provided, looking up from zone name');
        
        // Make sure the zone name has a trailing dot which Route53 requires
        const zoneName = this.zone.endsWith('.') ? this.zone : `${this.zone}.`;
        
        const command = new ListHostedZonesByNameCommand({
          DNSName: zoneName
        });
        
        const response = await this.route53.send(command);
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
      
      // Initialize the DNS record cache
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
        const command = new ListResourceRecordSetsCommand(route53Params);
        const response = await this.route53.send(command);
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
}

module.exports = Route53Provider;