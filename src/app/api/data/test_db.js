const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const supabase = createClient(config.supabase.url, config.supabase.key, {
    auth: { persistSession: false }
});

async function run() {
    const tableKey = 'stg_businesspartnergroups_14'; // replace appropriately
    const { data: colsData, error: colsErr } = await supabase.rpc('exec_sql', {
        query: `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableKey}' ORDER BY ordinal_position;`
    });

    console.log('Error:', colsErr);
    console.log('Cols:', colsData);
}

run();
