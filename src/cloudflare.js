/**
 * Cloudflare API client for DNS management
 */
const axios = require('axios');

class CloudflareAPI {
  constructor(config) {
    this.config = config;
    this.token = config.cloudflareToken;
    this.zone = config.cloudflareZone;
    this.zoneId = null;
    
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
      console.log(`Cloudflare zone ID for ${this.zone}: ${this.zoneId}`);
      
      return true;
    } catch (error) {
      console.error('Failed to initialize Cloudflare API:', error.message);
      throw new Error(`Failed to initialize Cloudflare API: ${error.message}`);
    }
  }
  
  /**
   * List DNS records with optional filtering
   */
  async listRecords(params = {}) {
    try {
      if (!this.zoneId) {
        await this.init();
      }
      
      const response = await this.client.get(`/zones/${this.zoneId}/dns_records`, {
        params
      });
      
      return response.data.result;
    } catch (error) {
      console.error('Failed to list DNS records:', error.message);
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
      
      console.log(`Created ${record.type} record for ${record.name}`);
      return response.data.result;
    } catch (error) {
      console.error(`Failed to create ${record.type} record for ${record.name}:`, error.message);
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
      
      console.log(`Updated ${record.type} record for ${record.name}`);
      return response.data.result;
    } catch (error) {
      console.error(`Failed to update ${record.type} record for ${record.name}:`, error.message);
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
      console.log(`Deleted DNS record with ID ${id}`);
      return true;
    } catch (error) {
      console.error(`Failed to delete DNS record with ID ${id}:`, error.message);
      throw error;
    }
  }
  
  /**
   * Ensure a DNS record exists and is up to date
   */
  async ensureRecord(record) {
    try {
      // Handle apex domains that need IP lookup
      if ((record.needsIpLookup || record.content === 'pending') && record.type === 'A') {
        // Get public IP asynchronously
        const ip = await this.config.getPublicIP();
        if (ip) {
          record.content = ip;
          console.log(`Retrieved public IP for apex domain ${record.name}: ${ip}`);
        } else {
          throw new Error(`Unable to determine public IP for apex domain A record: ${record.name}`);
        }
        // Remove the flag to avoid confusion
        delete record.needsIpLookup;
      }
      
      // Validate the record
      this.validateRecord(record);
      
      // Search for existing record
      const existingRecords = await this.listRecords({
        type: record.type,
        name: record.name
      });
      
      if (existingRecords.length > 0) {
        const existing = existingRecords[0];
        
        // Check if update is needed
        if (this.recordNeedsUpdate(existing, record)) {
          return await this.updateRecord(existing.id, record);
        }
        
        console.log(`${record.type} record for ${record.name} already up to date`);
        return existing;
      } else {
        // Create new record
        return await this.createRecord(record);
      }
    } catch (error) {
      console.error(`Failed to ensure record for ${record.name}:`, error.message);
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
        console.warn(`Warning: Record type ${record.type} may not be fully supported`);
    }
    
    // Proxied is only valid for certain record types
    if (record.proxied && !['A', 'AAAA', 'CNAME'].includes(record.type)) {
      console.warn(`Warning: 'proxied' is not valid for ${record.type} records. Setting to false.`);
      record.proxied = false;
    }
  }
}

module.exports = CloudflareAPI;