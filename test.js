const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const c = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const supabase = createClient(c.supabase.url, c.supabase.key);

async function run() {
    const { data } = await supabase.from('stg_plano_contas').select('*').limit(3);
    console.log(JSON.stringify(data, null, 2));
}
run();
