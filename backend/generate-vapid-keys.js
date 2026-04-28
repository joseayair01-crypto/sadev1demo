const webPush = require('web-push');

const keys = webPush.generateVAPIDKeys();

console.log('');
console.log('Agrega estas variables a backend/.env o a tu entorno de produccion:');
console.log('');
console.log(`PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('PUSH_VAPID_SUBJECT=mailto:tu-correo@dominio.com');
console.log('PUSH_TOKEN_SECRET=pon-aqui-un-secreto-largo-y-unico');
console.log('');
