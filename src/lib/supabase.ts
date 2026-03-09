
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://tdieqskomdgjjohywgzo.supabase.co';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_EmEl3u86l5qdmxxTseKIsQ_qaeRpovL';

export const supabase = createClient(supabaseUrl, supabaseKey);
