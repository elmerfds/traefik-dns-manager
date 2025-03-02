/**
 * Logger utility for Traefik DNS Manager
 * Provides different log levels with appropriate formatting
 */

// Define log levels
const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    TRACE: 4
  };
  
  class Logger {
    constructor() {
      // Default to INFO level unless specified in environment
      this.level = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;
      
      // Log level name mapping for debug/trace outputs
      this.levelNames = {
        [LOG_LEVELS.ERROR]: 'ERROR',
        [LOG_LEVELS.WARN]: 'WARN',
        [LOG_LEVELS.INFO]: 'INFO',
        [LOG_LEVELS.DEBUG]: 'DEBUG',
        [LOG_LEVELS.TRACE]: 'TRACE'
      };
      
      // Symbols for prettier INFO level logs
      this.symbols = {
        success: '✓',
        info: 'ℹ️',
        complete: '✅',
        error: '❌',
        warning: '⚠️'
      };
    }
    
    /**
     * Format timestamp for logs
     * INFO level gets simplified timestamp, other levels get more detailed
     */
    formatTimestamp(level) {
      const now = new Date();
      
      if (level === LOG_LEVELS.INFO) {
        // Simpler timestamp for INFO level
        return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
      } else {
        // More detailed timestamp for other levels
        return now.toISOString();
      }
    }
    
    /**
     * Log a message if the current log level allows it
     */
    log(level, message, symbol = null) {
      if (level > this.level) return;
      
      let formattedMessage;
      
      if (level === LOG_LEVELS.INFO && symbol) {
        // Pretty format for INFO level
        formattedMessage = `${this.formatTimestamp(level)} ${symbol} ${message}`;
      } else {
        // Standard format for other levels
        formattedMessage = `${this.formatTimestamp(level)} [${this.levelNames[level]}] ${message}`;
      }
      
      console.log(formattedMessage);
    }
    
    // ERROR level - only critical errors that break functionality
    error(message) {
      this.log(LOG_LEVELS.ERROR, message, this.symbols.error);
    }
    
    // WARN level - important warnings that don't break functionality
    warn(message) {
      this.log(LOG_LEVELS.WARN, message, this.symbols.warning);
    }
    
    // INFO level - key operational information
    info(message) {
      this.log(LOG_LEVELS.INFO, message, this.symbols.info);
    }
    
    // Success message - INFO level but with success symbol
    success(message) {
      this.log(LOG_LEVELS.INFO, message, this.symbols.success);
    }
    
    // Completion message - INFO level but with complete symbol
    complete(message) {
      this.log(LOG_LEVELS.INFO, message, this.symbols.complete);
    }
    
    // DEBUG level - detailed information for troubleshooting
    debug(message) {
      this.log(LOG_LEVELS.DEBUG, message);
    }
    
    // TRACE level - extremely detailed information
    trace(message) {
      this.log(LOG_LEVELS.TRACE, message);
    }
    
    // Allow changing log level at runtime
    setLevel(levelName) {
      const newLevel = LOG_LEVELS[levelName?.toUpperCase()];
      if (newLevel !== undefined) {
        this.level = newLevel;
        this.info(`Log level changed to ${levelName.toUpperCase()}`);
        return true;
      }
      return false;
    }
  }
  
  // Create and export singleton instance
  const logger = new Logger();
  module.exports = logger;