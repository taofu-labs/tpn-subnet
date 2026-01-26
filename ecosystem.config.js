const fs = require('fs');
const path = require('path');

/**
 * Robust .env parser that doesn't require dependencies.
 * @param {string} filePath 
 */
function parseEnv(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').reduce((acc, line) => {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
            let value = match[2] || '';
            if (value.length > 0 && value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1);
            }
            acc[match[1]] = value;
        }
        return acc;
    }, {});
}

// 1. Identify Config Path (Supports --mock for local Mac testing)
const isMock = process.argv.includes('--mock');
const envPath = isMock
    ? path.join(__dirname, '.env.mock.test')
    : path.join(__dirname, 'federated-container', '.env');

const config = parseEnv(envPath);

// Combine process.env and parsed config for resolution
const env = { ...config, ...process.env };

// 2. Logic-Aware Defaults (Strictly following TPN README)
const mode = env.RUN_MODE || 'miner';
const network = (env.TPN_NETWORK || 'finney').toLowerCase();
const isTest = network === 'test';

const netuid = env.TPN_NETUID || (isTest ? '279' : '65');
const subtensor = env.TPN_SUBTENSOR_NETWORK || (isTest ? 'test' : 'finney');
const wallet = env.TPN_WALLET_NAME || 'tpn_coldkey';
const hotkey = env.TPN_HOTKEY_NAME || 'tpn_hotkey';
const axon_port = env.TPN_AXON_PORT || (mode === 'miner' ? '8091' : '9000');

// 3. Build CLI Arguments
const baseArgs = [
    `--netuid ${netuid}`,
    `--subtensor.network ${subtensor}`,
    `--wallet.name ${wallet}`,
    `--wallet.hotkey ${hotkey}`,
    `--logging.debug`
];

let port;
let script;
let extraArgs = [];

// Standard TPN logic: Miners use blacklist permit, Validators use force permit
if (mode === 'miner') {
    port = env.TPN_AXON_PORT || '8091';
    script = 'bittensor/neurons/miner.py';
    extraArgs = [
        '--blacklist.force_validator_permit'
    ];
} else if (mode === 'validator') {
    port = env.TPN_AXON_PORT || '9000';
    script = 'bittensor/neurons/validator.py';
    extraArgs = [
        '--neuron.vpermit', '10000',
        '--force_validator_permit'
    ];
}

const apps = [{
    name: `tpn_${mode}`,
    script: script,
    interpreter: "venv/bin/python3",
    args: baseArgs.join(' '),
    env: {
        PYTHONPATH: "."
    }
}];

// 4. Export or Dump
if (process.argv.includes('--dump')) {
    console.log('🚀 TPN PM2 Dry Run (Dump Mode)');
    console.log('------------------------------');
    console.log('Config Source:', envPath);
    console.log(JSON.stringify(apps, null, 2));
} else {
    module.exports = { apps };
}
