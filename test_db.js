const { createClient } = require('@supabase/supabase-js');
const config = require('./config.json');
const supabase = createClient(config.supabase.url, config.supabase.key);

async function run() {
    const { data, error } = await supabase.from('migration_entities').select('*').ilike('name', '%Chart%');
    console.log(JSON.stringify(data, null, 2));
}
run();
