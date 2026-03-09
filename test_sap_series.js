/**
 * Verifica os campos da tabela SE2010 no Supabase e o endpoint
 * JournalEntries do SAP B1 para entender a estrutura necessária
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SAP_URL = 'https://sap-alfasap-sl.skyinone.net:50000/b1s/v1';
const COMPANY_DB = 'SBO_ALFAERP_PRD';
const USER_NAME = 'manager';
const PASSWORD = '1234';

async function login() {
    const res = await fetch(`${SAP_URL}/Login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CompanyDB: COMPANY_DB, UserName: USER_NAME, Password: PASSWORD })
    });
    if (!res.ok) throw new Error(`Login: ${res.status}`);
    return res.headers.get('set-cookie');
}

async function main() {
    const cookies = await login();
    console.log('✅  Login OK\n');

    // ── 1. Sample existing JournalEntries ──
    console.log('━'.repeat(60));
    console.log('1. Exemplo de JournalEntry existente no SAP B1');
    console.log('━'.repeat(60));

    const jeRes = await fetch(`${SAP_URL}/JournalEntries?$top=1&$orderby=JdtNum desc`, {
        headers: { 'Cookie': cookies }
    });
    if (jeRes.ok) {
        const j = await jeRes.json();
        const first = j.value?.[0];
        if (first) {
            console.log('\nEstrutura de um JournalEntry:');
            // Top-level fields
            const topFields = Object.keys(first).filter(k => !Array.isArray(first[k]));
            topFields.forEach(f => console.log(`  ${f}: ${JSON.stringify(first[f])}`));

            // JournalEntryLines
            if (first.JournalEntryLines?.length > 0) {
                console.log('\n  JournalEntryLines[0]:');
                Object.entries(first.JournalEntryLines[0]).forEach(([k, v]) => {
                    console.log(`    ${k}: ${JSON.stringify(v)}`);
                });
            }
        }
    } else {
        const t = await jeRes.text();
        console.log('❌ JournalEntries Error:', t.slice(0, 200));
    }

    // ── 2. Check what ChartOfAccounts exist for AP ──
    console.log('\n' + '━'.repeat(60));
    console.log('2. Chart of Accounts (Contas do Plano para CP/CR)');
    console.log('━'.repeat(60));

    const coaRes = await fetch(`${SAP_URL}/ChartOfAccounts?$filter=AccountType eq 'at_Liability'&$select=Code,Name,AccountType&$top=5`, {
        headers: { 'Cookie': cookies }
    });
    if (coaRes.ok) {
        const coa = await coaRes.json();
        console.log('\nContas de Passivo (Liability) - amostra:');
        (coa.value || []).forEach(a => console.log(`  ${a.Code} | ${a.Name}`));
    }

    // ── 3. Check OACT for AP/AR accounts ──
    console.log('\n' + '━'.repeat(60));
    console.log('3. Busca conta de Fornecedores no Plano de Contas');
    console.log('━'.repeat(60));

    const apRes = await fetch(`${SAP_URL}/ChartOfAccounts?$filter=contains(Name,'Forneced')&$select=Code,Name,AccountType&$top=10`, {
        headers: { 'Cookie': cookies }
    });
    if (apRes.ok) {
        const ap = await apRes.json();
        console.log('\nContas com "Forneced" no nome:');
        (ap.value || []).forEach(a => console.log(`  ${a.Code} | ${a.Name} | ${a.AccountType}`));
    }

    // ── 4. Check Vendor-linked accounts via BusinessPartner example ──
    const bpRes = await fetch(`${SAP_URL}/BusinessPartners('F000507')?$select=CardCode,CardName,ControlAccount`, {
        headers: { 'Cookie': cookies }
    });
    if (bpRes.ok) {
        const bp = await bpRes.json();
        console.log('\n  Conta controle do F000507:', bp.ControlAccount);
    }

    console.log('\n' + '═'.repeat(60) + '\n');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
