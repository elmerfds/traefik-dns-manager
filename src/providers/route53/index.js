/**
 * Route53 Provider module
 * Exports the Route53 DNS provider implementation
 */
const Route53Provider = require('./provider');
const { convertRecord, convertToRoute53Format, ensureTrailingDot } = require('./converter');
const { validateRecord } = require('./validator');
const { standardizeRecords, recordNeedsUpdate } = require('./recordUtils');
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

// Export the provider class as default
module.exports = Route53Provider;

// Also export utility functions
module.exports.convertRecord = convertRecord;
module.exports.convertToRoute53Format = convertToRoute53Format;
module.exports.ensureTrailingDot = ensureTrailingDot;
module.exports.validateRecord = validateRecord;
module.exports.standardizeRecords = standardizeRecords;
module.exports.recordNeedsUpdate = recordNeedsUpdate;
module.exports.fetchAllRecords = fetchAllRecords;
module.exports.findRecordInCache = findRecordInCache;
module.exports.updateRecordInCache = updateRecordInCache;
module.exports.removeRecordFromCache = removeRecordFromCache;
module.exports.createRecord = createRecord;
module.exports.updateRecord = updateRecord;
module.exports.deleteRecord = deleteRecord;
module.exports.batchEnsureRecords = batchEnsureRecords;