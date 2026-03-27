import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function run() {
  const { data, error } = await supabase.from('ibge_municipios').select('*').eq('municipio', '11300');
  console.log('Result for 11300:', data, error);
}
run();
