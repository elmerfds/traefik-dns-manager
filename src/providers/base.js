/**
 * Abstract DNS Provider Interface
 * Base class for all DNS provider implementations
 */
class DNSProvider {
  /**
   * Constructor for the DNS provider
   * @param {Object} config - Configuration manager instance
   */
  constructor(config) {
    if (this.constructor === DNSProvider) {
      throw new Error('DNSProvider is an abstract class and cannot be instantiated directly');
    }
    
    this.config = config;
    
    // Initialize record cache
    this.recordCache = {
      records: [],
      lastUpdated: 0
    };
  }
  
  /**
   * Initialize the provider
   * @returns {Promise<boolean>} - True if initialization was successful
   */
  async init() {
    throw new Error('Method init() must be implemented by subclass');
  }
  
  /**
   * Refresh the DNS record cache
   * @returns {Promise<Array>} - Array of DNS records
   */
  async refreshRecordCache() {
    throw new Error('Method refreshRecordCache() must be implemented by subclass');
  }
  
  /**
   * Get records from cache, refreshing if necessary
   * @param {boolean} forceRefresh - Force refresh the cache
   * @returns {Promise<Array>} - Array of DNS records
   */
  async getRecordsFromCache(forceRefresh = false) {
    const cacheAge = Date.now() - this.recordCache.lastUpdated;
    const cacheRefreshInterval = this.config.cacheRefreshInterval;
    
    // Check if cache is stale or if force refresh is requested
    if (forceRefresh || cacheAge > cacheRefreshInterval || this.recordCache.records.length === 0) {
      await this.refreshRecordCache();
    }
    
    return this.recordCache.records;
  }
  
  /**
   * Find a record in the cache
   * @param {string} type - Record type
   * @param {string} name - Record name
   * @returns {Object|null} - The found record or null
   */
  findRecordInCache(type, name) {
    return this.recordCache.records.find(
      record => record.type === type && record.name === name
    );
  }
  
  /**
   * List DNS records with optional filtering
   * @param {Object} params - Filter parameters
   * @returns {Promise<Array>} - Array of DNS records
   */
  async listRecords(params = {}) {
    throw new Error('Method listRecords() must be implemented by subclass');
  }
  
  /**
   * Create a new DNS record
   * @param {Object} record - The record to create
   * @returns {Promise<Object>} - The created record
   */
  async createRecord(record) {
    throw new Error('Method createRecord() must be implemented by subclass');
  }
  
  /**
   * Update an existing DNS record
   * @param {string} id - Record ID
   * @param {Object} record - The record data to update
   * @returns {Promise<Object>} - The updated record
   */
  async updateRecord(id, record) {
    throw new Error('Method updateRecord() must be implemented by subclass');
  }
  
  /**
   * Delete a DNS record
   * @param {string} id - Record ID
   * @returns {Promise<boolean>} - True if deletion was successful
   */
  async deleteRecord(id) {
    throw new Error('Method deleteRecord() must be implemented by subclass');
  }
  
  /**
   * Batch process multiple DNS records at once
   * @param {Array<Object>} recordConfigs - Array of record configurations
   * @returns {Promise<Array>} - Array of processed records
   */
  async batchEnsureRecords(recordConfigs) {
    throw new Error('Method batchEnsureRecords() must be implemented by subclass');
  }
  
  /**
   * Check if a record needs to be updated
   * @param {Object} existing - The existing record
   * @param {Object} newRecord - The new record data
   * @returns {boolean} - True if the record needs to be updated
   */
  recordNeedsUpdate(existing, newRecord) {
    throw new Error('Method recordNeedsUpdate() must be implemented by subclass');
  }
  
  /**
   * Validate a record configuration
   * @param {Object} record - The record to validate
   */
  validateRecord(record) {
    throw new Error('Method validateRecord() must be implemented by subclass');
  }
}

module.exports = DNSProvider;