/**
 * DNS Record Tracker
 * Tracks which DNS records have been created/managed by this tool
 * for consistent cleanup across different DNS providers
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class RecordTracker {
  constructor(config) {
    this.config = config;
    this.trackedRecords = new Map();
    this.trackerFile = path.join(process.cwd(), 'dns-records.json');
    this.providerDomain = config.getProviderDomain();
    this.provider = config.dnsProvider;
    
    // Load preserved hostnames from config
    this.loadPreservedHostnames();
    
    // Initialise the tracker
    this.loadTrackedRecords();
  }
  
  /**
   * Load preserved hostnames from environment variable
   */
  loadPreservedHostnames() {
    try {
      const preservedHostnamesStr = process.env.PRESERVED_HOSTNAMES || '';
      
      // Split by comma and trim each hostname
      this.preservedHostnames = preservedHostnamesStr
        .split(',')
        .map(hostname => hostname.trim())
        .filter(hostname => hostname.length > 0);
      
      // Don't log here - will be displayed in startup banner by StatusReporter
      if (this.preservedHostnames.length === 0) {
        logger.debug('No preserved hostnames configured');
        this.preservedHostnames = [];
      }
    } catch (error) {
      logger.error(`Error loading preserved hostnames: ${error.message}`);
      this.preservedHostnames = [];
    }
  }
  
  /**
   * Load tracked records from file
   */
  loadTrackedRecords() {
    try {
      if (fs.existsSync(this.trackerFile)) {
        const data = fs.readFileSync(this.trackerFile, 'utf8');
        const records = JSON.parse(data);
        
        // Convert to Map for faster lookups
        this.trackedRecords = new Map();
        
        // Process each record
        for (const record of records) {
          const key = this.getRecordKey(record.provider, record.domain, record.name, record.type);
          this.trackedRecords.set(key, record);
        }
        
        logger.debug(`Loaded ${this.trackedRecords.size} tracked DNS records from ${this.trackerFile}`);
      } else {
        logger.debug(`No DNS record tracker file found at ${this.trackerFile}, starting fresh`);
        this.trackedRecords = new Map();
        this.saveTrackedRecords();
      }
    } catch (error) {
      logger.error(`Error loading tracked DNS records: ${error.message}`);
      // Start with empty tracking if file load fails
      this.trackedRecords = new Map();
    }
  }
  
  /**
   * Save tracked records to file
   */
  saveTrackedRecords() {
    try {
      const records = Array.from(this.trackedRecords.values());
      fs.writeFileSync(this.trackerFile, JSON.stringify(records, null, 2), 'utf8');
      logger.debug(`Saved ${records.length} tracked DNS records to ${this.trackerFile}`);
    } catch (error) {
      logger.error(`Error saving tracked DNS records: ${error.message}`);
    }
  }
  
  /**
   * Create a unique key for a record
   */
  getRecordKey(provider, domain, name, type) {
    return `${provider}:${domain}:${name}:${type}`.toLowerCase();
  }
  
  /**
   * Track a new DNS record
   */
  trackRecord(record) {
    const key = this.getRecordKey(
      this.provider,
      this.providerDomain,
      record.name,
      record.type
    );
    
    this.trackedRecords.set(key, {
      id: record.id,
      provider: this.provider,
      domain: this.providerDomain,
      name: record.name,
      type: record.type,
      createdAt: new Date().toISOString(),
      managedBy: 'TráfegoDNS'
    });
    
    // Save after each new record to prevent data loss
    this.saveTrackedRecords();
    
    logger.debug(`Tracked new DNS record: ${record.name} (${record.type})`);
  }
  
  /**
   * Remove a tracked record
   */
  untrackRecord(record) {
    const key = this.getRecordKey(
      this.provider,
      this.providerDomain,
      record.name,
      record.type
    );
    
    const wasTracked = this.trackedRecords.delete(key);
    
    if (wasTracked) {
      // Save after removing a record
      this.saveTrackedRecords();
      logger.debug(`Removed tracked DNS record: ${record.name} (${record.type})`);
    }
    
    return wasTracked;
  }
  
  /**
   * Check if a record is tracked
   */
  isTracked(record) {
    const key = this.getRecordKey(
      this.provider,
      this.providerDomain,
      record.name,
      record.type
    );
    
    return this.trackedRecords.has(key);
  }
  
  /**
   * Get all tracked records
   */
  getAllTrackedRecords() {
    return Array.from(this.trackedRecords.values());
  }
  
  /**
   * Get tracked records for current provider and domain
   */
  getCurrentProviderRecords() {
    const records = [];
    
    for (const [key, record] of this.trackedRecords.entries()) {
      if (record.provider === this.provider && record.domain === this.providerDomain) {
        records.push(record);
      }
    }
    
    return records;
  }
  
  /**
   * Check if a hostname is in the preserved list
   * @param {string} hostname - The hostname to check
   * @returns {boolean} - True if the hostname should be preserved
   */
  shouldPreserveHostname(hostname) {
    // Normalize hostname for comparison (trim, lowercase)
    const normalizedHostname = hostname.trim().toLowerCase();
    
    // Check exact match
    if (this.preservedHostnames.some(h => h.toLowerCase() === normalizedHostname)) {
      logger.debug(`Hostname ${hostname} is in the preserved list (exact match)`);
      return true;
    }
    
    // Check for wildcard match (*.example.com)
    for (const preservedHostname of this.preservedHostnames) {
      if (preservedHostname.startsWith('*.')) {
        const wildcardDomain = preservedHostname.substring(2).toLowerCase();
        if (normalizedHostname.endsWith(wildcardDomain) && 
            normalizedHostname.length > wildcardDomain.length) {
          logger.debug(`Hostname ${hostname} matched wildcard pattern ${preservedHostname}`);
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * Update a record ID (when a record is updated/recreated)
   */
  updateRecordId(oldRecord, newRecord) {
    const key = this.getRecordKey(
      this.provider,
      this.providerDomain,
      oldRecord.name,
      oldRecord.type
    );
    
    if (this.trackedRecords.has(key)) {
      const record = this.trackedRecords.get(key);
      record.id = newRecord.id;
      record.updatedAt = new Date().toISOString();
      this.trackedRecords.set(key, record);
      this.saveTrackedRecords();
      logger.debug(`Updated tracked DNS record ID: ${oldRecord.name} (${oldRecord.type})`);
    }
  }
}

module.exports = RecordTracker;