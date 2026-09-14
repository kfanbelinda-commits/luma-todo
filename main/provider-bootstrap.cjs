'use strict';

// Install provider-ownership boundaries before the compatibility bootstrap
// loads main.cjs and captures the sync-engine exports.
const { installAppleOwnershipBoundary } = require('./provider-ownership.cjs');

installAppleOwnershipBoundary();
require('./safety-bootstrap.cjs');
