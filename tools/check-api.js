'use strict';

/*
 * Quick check of the EcoSense cloud without ioBroker.
 *
 * Usage (inside the adapter folder, after "npm install"):
 *   ECOSENSE_EMAIL="you@example.com" ECOSENSE_PASSWORD="secret" node tools/check-api.js
 *
 * Prints every device and every field the API returns.
 * Personal data (e-mail, public IP, Wi-Fi name, location) is removed from the
 * output, so you can paste the result into a GitHub issue. The password is never printed.
 */

const { EcoSenseClient, sanitizeDevice, PRIVATE_FIELDS } = require('../lib/api');

const email = process.env.ECOSENSE_EMAIL;
const password = process.env.ECOSENSE_PASSWORD;

if (!email || !password) {
    console.error('Please set ECOSENSE_EMAIL and ECOSENSE_PASSWORD.');
    process.exit(1);
}

function mask(value) {
    if (typeof value !== 'string') {
        return value;
    }
    return value.replace(/([^@\s"]{1,2})[^@\s"]*@([^\s".]+)/g, '$1***@$2');
}

(async () => {
    const client = new EcoSenseClient(email, password);
    try {
        process.stdout.write('Login ... ');
        await client.login();
        console.log('ok');

        process.stdout.write('Reading devices ... ');
        const devices = (await client.getDevices()).map(sanitizeDevice);
        console.log(`${devices.length} device(s)\n`);

        devices.forEach((dev, i) => {
            console.log(`--- Device ${i + 1} ---`);
            for (const [key, value] of Object.entries(dev)) {
                const shown = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
                console.log(
                    `${key.padEnd(24)} ${typeof value === 'object' ? 'object' : typeof value}`.padEnd(34),
                    mask(String(shown)),
                );
            }
            console.log('');
        });

        console.log(`Raw JSON (removed: ${PRIVATE_FIELDS.join(', ')}):`);
        console.log(mask(JSON.stringify(devices, null, 2)));
    } catch (err) {
        console.log('FAILED');
        console.error(
            `${err.name}${err.code ? ` (${err.code})` : ''}${err.status ? ` [HTTP ${err.status}]` : ''}: ${err.message}`,
        );
        process.exit(2);
    }
})();
