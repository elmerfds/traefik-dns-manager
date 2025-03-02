/**
 * Docker API client for monitoring container events
 */
const Docker = require('dockerode');
const logger = require('./logger');

class DockerAPI {
  constructor(config) {
    this.config = config;
    
    // Initialize Docker client
    this.docker = new Docker({
      socketPath: config.dockerSocket
    });
  }
  
  /**
   * List all running containers
   */
  async listContainers() {
    try {
      return await this.docker.listContainers({
        all: false // Only running containers
      });
    } catch (error) {
      logger.error(`Failed to list containers: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get container details by ID
   */
  async getContainer(id) {
    try {
      const container = this.docker.getContainer(id);
      const details = await container.inspect();
      return details;
    } catch (error) {
      logger.error(`Failed to get container ${id}: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get Docker events stream
   */
  async getEvents(filters = { type: ['container'] }) {
    try {
      return await this.docker.getEvents({
        filters
      });
    } catch (error) {
      logger.error(`Failed to get Docker events: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Test the connection to the Docker socket
   */
  async testConnection() {
    try {
      const info = await this.docker.info();
      return true;
    } catch (error) {
      logger.error(`Failed to connect to Docker: ${error.message}`);
      return false;
    }
  }
}

module.exports = DockerAPI;