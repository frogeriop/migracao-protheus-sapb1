const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('config.json'));
const sb = createClient(config.supabase.url, config.supabase.key);

(async () => {
    const { data, error } = await sb.from('se2010').select('*').limit(2);
    if (error) return console.error('Error:', error.message);
    if (!data || data.length === 0) return console.log('SE2010 vazio ou não existe');
    console.log('Colunas da SE2010 (primeiro registro):');
    Object.entries(data[0]).forEach(([k, v]) => {
        const val = String(v === null ? 'null' : v).slice(0, 60);
        console.log('  ', k.padEnd(20), ':', val);
    });
    console.log('\n--- Registro 2 ---');
    if (data[1]) {
        Object.entries(data[1]).forEach(([k, v]) => {
            const val = String(v === null ? 'null' : v).slice(0, 60);
            console.log('  ', k.padEnd(20), ':', val);
        });
    }
})();
