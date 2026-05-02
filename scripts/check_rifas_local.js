require('dotenv').config({ path: './backend/.env' });
(async ()=>{
  try{
    const db = require('../backend/db');
    const has = await db.schema.hasTable('rifas');
    console.log('hasTable', has);
    if(!has){ await db.destroy(); return; }
    const countRes = await db('rifas').count('* as cnt');
    const cnt = countRes && countRes[0] ? countRes[0].cnt : 0;
    console.log('count', cnt);
    const sample = await db('rifas').select('id','slug','nombre','es_predeterminada','activa_publica').limit(10);
    console.log('sampleRows', sample);
      // Mostrar configuración completa de la rifa principal (si existe)
      if(sample && sample.length > 0){
        const r = await db('rifas').where('id', sample[0].id).first('configuracion');
        console.log('configuracion (rifa id', sample[0].id + '):', JSON.stringify(r.configuracion, null, 2));
      }
    await db.destroy();
  }catch(e){ console.error('ERROR', e && e.message ? e.message : e); process.exit(1);} 
})();
