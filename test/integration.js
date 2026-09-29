const path = require('path');
const { tests } = require('@iobroker/testing');

// Starts the adapter in a real js-controller environment (without credentials it must start and stay alive)
tests.integration(path.join(__dirname, '..'));
