import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

// Load env vars
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkData() {
  console.log('Verifying data in migration_entities...');
  
  const { data, error, count } = await supabase
    .from('migration_entities')
    .select('*', { count: 'exact' });

  if (error) {
    console.error('Error querying table:', error.message);
    return;
  }

  console.log(`\nSuccess! Found ${count} rows.`);
  
  if (data && data.length > 0) {
    const bpGroups = data.find(d => d.target_object === 'BusinessPartnerGroups');
    console.log('\nEntity BusinessPartnerGroups:');
    console.log(JSON.stringify(bpGroups, null, 2));
  }
}

checkData();
