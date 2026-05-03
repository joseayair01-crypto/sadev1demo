const testConcurrency = async () => {
    const u = 'https://sadev1demo-production.up.railway.app/api/public/order-counter/next';
    const h = { 'Content-Type': 'application/json', 'x-rifa-id': '1' };
    const ps = [];
    
    for (let i = 0; i < 20; i++) {
        ps.push(
            fetch(u, { method: 'POST', headers: h, body: JSON.stringify({}) })
                .then(r => r.json())
                .catch(e => ({ error: e.message }))
        );
    }
    
    const res = await Promise.all(ps);
    const ids = res.filter(r => r.orden_id).map(r => r.orden_id).sort();
    const uniq = new Set(ids);
    
    console.log('\n' + '='.repeat(80));
    console.log('TEST: 20 GENERACIONES PARALELAS');
    console.log('='.repeat(80));
    console.log('\nGeneradas 20 paralelas:');
    console.log('  Total:', ids.length);
    console.log('  Únicas:', uniq.size);
    console.log('  IDs:', ids.slice(0, 10).join(', '), '...');
    
    if (ids.length !== uniq.size) {
        console.log('\n❌ DUPLICADOS ENCONTRADOS!');
        const seen = new Map();
        ids.forEach(id => {
            if (!seen.has(id)) seen.set(id, 0);
            seen.set(id, seen.get(id) + 1);
        });
        seen.forEach((count, id) => {
            if (count > 1) console.log(`  ❌ ${id} (aparece ${count} veces)`);
        });
    } else {
        console.log('\n✅ Sin duplicados - GENERADOR FUNCIONA CORRECTAMENTE');
    }
    
    console.log('='.repeat(80) + '\n');
};

testConcurrency();
