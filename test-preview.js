const fs = require('fs/promises');
const fetch = require('node-fetch'); // we can just mock or test pure logic
const { createClient } = require('@supabase/supabase-js');

async function run() {
  const config = JSON.parse(await fs.readFile('./config.json', 'utf8'));
  const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });
  
  const mapping = JSON.parse(await fs.readFile('./mapping.json', 'utf8')).SA1010;
  
  // mock source record
  const sourceRecord = {
    A1_COD: '123',
    A1_EST: 'SP',
    A1_COD_MUN: '50308',
    A1_MUN: 'SAO PAULO'
  };

  const field = mapping.fields.find(f => f.target === 'BPAddresses.County');
  
  let q = supabase.from(field.rule.lookupTable).select(field.rule.lookupValue);
  
  const ck = field.rule.compositeKey;
  const lf = ck.lookupKeyFields[0]; // 'uf'
  const munIndex = ck.lookupKeyFields.indexOf('municipio');

  console.log('Lookup fields:', ck);
  
  const UF_CODES = {
      'RO':'11', 'AC':'12', 'AM':'13', 'RR':'14', 'PA':'15', 'AP':'16', 'TO':'17',
      'MA':'21', 'PI':'22', 'CE':'23', 'RN':'24', 'PB':'25', 'PE':'26', 'AL':'27', 'SE':'28', 'BA':'29',
      'MG':'31', 'ES':'32', 'RJ':'33', 'SP':'35',
      'PR':'41', 'SC':'42', 'RS':'43',
      'MS':'50', 'MT':'51', 'GO':'52', 'DF':'53'
  };
  
  const rawUf = sourceRecord['A1_EST'];
  const rawMun = sourceRecord['A1_COD_MUN'];
  console.log('rawUf:', rawUf, 'rawMun:', rawMun);
  
  const exactIbge = UF_CODES[rawUf.toUpperCase()] + rawMun;
  console.log('exactIbge:', exactIbge);
  
  const { data, error } = await supabase.from('ibge_municipios').select('codigo_ibge').eq('codigo_ibge', exactIbge).maybeSingle();
  console.log('Supabase result:', data, error);
}

run();
