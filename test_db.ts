import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const supabase = createClient(config.supabase.url, config.supabase.key);

async function run() {
    const { data, error } = await supabase.from('migration_entities').select('*').ilike('name', '%Chart%');
    console.log(JSON.stringify(data, null, 2));
}
run();
