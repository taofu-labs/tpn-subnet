const http = require('http');

const PORT = 57287;

const server = http.createServer((req, res) => {
    console.log(`\n📥 Received ${req.method} request to: ${req.url}`);

    // Whitelist check log (simulating federation behavior)
    console.log(`🔒 Request headers:`, JSON.stringify(req.headers, null, 2));

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        if (req.url === '/protocol/broadcast/neurons' && req.method === 'POST') {
            try {
                const data = JSON.parse(body);
                const neurons = data.neurons || [];
                const count = neurons.length;
                console.log(`✅ Received broadcast for ${count} neurons.`);

                // Privacy Check: Look for the local neuron (uid 62 in your test)
                const myNeuron = neurons.find(n => n.uid === 62);
                if (myNeuron) {
                    console.log(`🔍 Privacy Check (UID 62): IP is "${myNeuron.ip}"`);
                    if (myNeuron.ip === '0.0.0.0' || myNeuron.ip === '') {
                        console.log(`🛡️ SUCCESS: Your IP is MASKED.`);
                    } else {
                        console.log(`⚠️ WARNING: IP "${myNeuron.ip}" is being broadcasted.`);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    validators: 1, // Mock count
                    miners: count - 1,   // Mock count
                    weight_copiers: 0
                }));
            } catch (e) {
                console.error('❌ Failed to parse JSON body');
                res.writeHead(400);
                res.end('Invalid JSON');
            }
        } else {
            console.log('❓ Route not matched. Returning 404.');
            res.writeHead(404);
            res.end();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Mock Federation API listening on port ${PORT}`);
    console.log(`🔗 Endpoint ready: http://localhost:${PORT}/protocol/broadcast/neurons`);
});
