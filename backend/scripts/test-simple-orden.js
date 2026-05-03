#!/usr/bin/env node

const https = require('https');
const url = require('url');

const BASE_URL = 'https://sadev1demo-production.up.railway.app';
const RIFA_ID = '1';

// Payload correcto
const payload = JSON.stringify({
    cliente: {
        nombre: 'Test Simple',
        apellidos: 'Load',
        whatsapp: '4121234567', // Exactamente 10 dígitos
        estado: 'Aragua',
        ciudad: 'Maracay'
    },
    boletos: [5], // Un boleto
    totales: {
        subtotal: 100,
        descuento: 0,
        totalFinal: 100
    }
});

console.log('📋 Payload:', payload);

const options = {
    hostname: new URL(BASE_URL).hostname,
    port: 443,
    path: '/api/ordenes',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-rifa-id': RIFA_ID
    },
    timeout: 10000
};

console.log('🔌 Conectando a:', BASE_URL + options.path);

const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log('\n✅ Respuesta recibida:');
        console.log('Status:', res.statusCode);
        console.log('Body:', data);
        try {
            const json = JSON.parse(data);
            console.log('\n📊 Respuesta JSON:');
            console.log(JSON.stringify(json, null, 2));
        } catch (e) {
            console.error('No se pudo parsear JSON');
        }
    });
});

req.on('error', (e) => {
    console.error('❌ Error:', e.message);
});

req.on('timeout', () => {
    console.error('⏱️ Timeout');
    req.destroy();
});

req.write(payload);
req.end();
