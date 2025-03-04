/**
 * Event Bus for application-wide event handling
 * Implements a simple pub/sub pattern for decoupled communication
 */
const EventEmitter = require('events');
const logger = require('../utils/logger');
const EventTypes = require('./EventTypes');

class EventBus {
  constructor() {
    this.emitter = new EventEmitter();
    
    // Set higher limit for listeners to avoid warnings
    this.emitter.setMaxListeners(20);
    
    // Track number of subscribers for debugging
    this.subscriberCounts = {};
    
    // Setup debug logging of events if in TRACE mode
    if (logger.level >= 4) { // TRACE level
      this.setupDebugLogging();
    }
  }
  
  /**
   * Subscribe to an event
   * @param {string} eventType - Event type from EventTypes
   * @param {Function} handler - Event handler function
   */
  subscribe(eventType, handler) {
    if (!Object.values(EventTypes).includes(eventType)) {
      logger.warn(`Subscribing to unknown event type: ${eventType}`);
    }
    
    this.emitter.on(eventType, handler);
    
    // Track subscriber counts
    this.subscriberCounts[eventType] = (this.subscriberCounts[eventType] || 0) + 1;
    logger.debug(`Subscribed to event ${eventType} (${this.subscriberCounts[eventType]} subscribers)`);
    
    // Return unsubscribe function for cleanup
    return () => {
      this.emitter.off(eventType, handler);
      this.subscriberCounts[eventType]--;
      logger.debug(`Unsubscribed from event ${eventType} (${this.subscriberCounts[eventType]} subscribers)`);
    };
  }
  
  /**
   * Publish an event
   * @param {string} eventType - Event type from EventTypes
   * @param {Object} data - Event data
   */
  publish(eventType, data = {}) {
    if (!Object.values(EventTypes).includes(eventType)) {
      logger.warn(`Publishing unknown event type: ${eventType}`);
    }
    
    if (this.subscriberCounts[eventType] && this.subscriberCounts[eventType] > 0) {
      logger.debug(`Publishing event ${eventType} to ${this.subscriberCounts[eventType]} subscribers`);
      this.emitter.emit(eventType, data);
    } else {
      logger.debug(`No subscribers for event ${eventType}`);
    }
  }
  
  /**
   * Setup debug logging of all events
   * Only active in TRACE log level
   */
  setupDebugLogging() {
    Object.values(EventTypes).forEach(eventType => {
      this.emitter.on(eventType, (data) => {
        logger.trace(`EVENT: ${eventType} - ${JSON.stringify(data)}`);
      });
    });
    
    logger.debug('Event debug logging enabled');
  }
}

module.exports = { EventBus };