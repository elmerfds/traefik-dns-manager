/**
 * Environment variable loader
 * Handles loading and validating environment variables
 */
class EnvironmentLoader {
    /**
     * Get environment variable with type conversion
     * @param {string} name - Environment variable name
     * @param {*} defaultValue - Default value if not set
     * @param {Function} converter - Converter function
     * @returns {*} The environment variable value
     */
    static get(name, defaultValue, converter = null) {
      const value = process.env[name];
      
      if (value === undefined) {
        return defaultValue;
      }
      
      if (converter) {
        try {
          return converter(value);
        } catch (error) {
          throw new Error(`Invalid format for environment variable ${name}: ${error.message}`);
        }
      }
      
      return value;
    }
    
    /**
     * Get environment variable as string
     */
    static getString(name, defaultValue = '') {
      return this.get(name, defaultValue);
    }
    
    /**
     * Get environment variable as integer
     */
    static getInt(name, defaultValue = 0) {
      return this.get(name, defaultValue, (value) => {
        const parsed = parseInt(value, 10);
        if (isNaN(parsed)) {
          throw new Error(`Expected an integer`);
        }
        return parsed;
      });
    }
    
    /**
     * Get environment variable as boolean
     */
    static getBool(name, defaultValue = false) {
      return this.get(name, defaultValue, (value) => {
        return value !== 'false';
      });
    }
    
    /**
     * Get required environment variable
     * @throws {Error} If the variable is not set
     */
    static getRequired(name) {
      const value = process.env[name];
      
      if (value === undefined) {
        throw new Error(`Required environment variable ${name} is not set`);
      }
      
      return value;
    }
  }
  
  module.exports = EnvironmentLoader;