/**
 * Operation utility functions for Route53 provider
 */
const { ChangeResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
const logger = require('../../utils/logger');
const { convertToRoute53Format } = require('./converter');
const { validateRecord } = require('./validator');

/**
 * Create a new DNS record
 */
async function createRecord(record) {
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
    const command = new ChangeResourceRecordSetsCommand(params);
    await this.route53.send(command);
    
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
async function updateRecord(id, record) {
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
    const command = new ChangeResourceRecordSetsCommand(params);
    await this.route53.send(command);
    
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
async function deleteRecord(id) {
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
    const command = new ChangeResourceRecordSetsCommand(params);
    await this.route53.send(command);
    
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
async function batchEnsureRecords(recordConfigs) {
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
          const command = new ChangeResourceRecordSetsCommand(params);
          await this.route53.send(command);
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

module.exports = {
  createRecord,
  updateRecord,
  deleteRecord,
  batchEnsureRecords
};