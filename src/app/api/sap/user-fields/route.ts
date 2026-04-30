import { NextResponse } from 'next/server';
import axios from 'axios';
import https from 'https';
import fs from 'fs/promises';
import path from 'path';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

/**
 * Mapa: objeto SAP (targetObject) → nome do EntityType no $metadata do Service Layer.
 */
const OBJECT_TO_ENTITY: Record<string, string> = {
    BusinessPartners: 'BusinessPartner',
    Items: 'Item',
    Orders: 'Order',
    JournalEntries: 'JournalEntry',
    ContactEmployees: 'ContactEmployee',
    Invoices: 'Invoice',
    PurchaseInvoices: 'PurchaseInvoice',
    ProfitCenters: 'ProfitCenter',
    BusinessPartnerGroups: 'BusinessPartnerGroup',
};

/**
 * Campos padrão do SAP que NÃO são UDFs mas podem ser confundidos (prefixo U_ ou TX_).
 * A rota retorna TODOS os campos extras (U_* e AF_*) encontrados no $metadata.
 */
const STANDARD_PREFIXES = ['U_', 'AF_'];

/** Faz login e retorna cookie header */
async function loginSap(baseURL: string, companyDB: string, userName: string, password: string, language: number) {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const client = axios.create({ baseURL, httpsAgent, headers: { 'Content-Type': 'application/json' } });
    const loginRes = await client.post('/Login', { CompanyDB: companyDB, UserName: userName, Password: password, Language: language });
    const rawCookies: string[] = loginRes.headers['set-cookie'] || [];
    const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');
    return { client, cookieHeader };
}

/**
 * Extrai do $metadata XML do Service Layer os campos de um EntityType específico.
 * Retorna todos os campos cujo nome começa com U_ ou AF_ (campos de usuário e localização).
 */
function parseMetadataFields(xml: string, entityTypeName: string): string[] {
    try {
        // Encontra o EntityType com o nome exato
        // Exemplo: <EntityType Name="BusinessPartner">
        const entityRegex = new RegExp(
            `<EntityType[^>]+Name="${entityTypeName}"[^>]*>([\\s\\S]*?)<\\/EntityType>`,
            'i'
        );
        const entityMatch = xml.match(entityRegex);
        if (!entityMatch) {
            console.warn(`[user-fields] EntityType "${entityTypeName}" não encontrado no $metadata`);
            return [];
        }

        const entityBody = entityMatch[1];
        // Extrai todas as propriedades: <Property Name="AF_HORASUPO" Type="..." />
        const propRegex = /<Property[^>]+Name="([^"]+)"/gi;
        const fields: string[] = [];
        let m;
        while ((m = propRegex.exec(entityBody)) !== null) {
            const name = m[1];
            if (STANDARD_PREFIXES.some(prefix => name.startsWith(prefix))) {
                fields.push(name);
            }
        }
        return fields.sort();
    } catch (e) {
        console.error('[user-fields] Erro ao parsear metadata XML:', e);
        return [];
    }
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const sapObject = searchParams.get('object') || 'BusinessPartners';
        const entityTypeName = OBJECT_TO_ENTITY[sapObject] ?? sapObject;

        // Load config
        const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
        const config = JSON.parse(raw);
        if (!config.sap) {
            return NextResponse.json({ success: false, message: 'SAP não configurado.' }, { status: 400 });
        }

        const { serviceLayerUrl, companyDB, userName, password, language } = config.sap;
        const baseURL = serviceLayerUrl.replace(/\/$/, '');

        const { client, cookieHeader } = await loginSap(baseURL, companyDB, userName, password, language || 29);

        let fields: string[] = [];
        let source = '';

        // 1. Tenta obter do $metadata (método mais completo — inclui campos AF_* de localização)
        try {
            const metaRes = await client.get('/$metadata', {
                headers: { Cookie: cookieHeader, Accept: 'application/xml' },
                responseType: 'text',
            });
            const xml: string = typeof metaRes.data === 'string' ? metaRes.data : '';
            if (xml.length > 100) {
                fields = parseMetadataFields(xml, entityTypeName);
                source = '$metadata';
                console.log(`[user-fields] $metadata: ${fields.length} campos U_*/AF_* para "${entityTypeName}"`);
            }
        } catch (metaErr: any) {
            console.warn('[user-fields] $metadata falhou:', metaErr.message);
        }

        // 2. Fallback: UserFieldsMD (campos criados pelo usuário via módulo UDF)
        if (fields.length === 0) {
            const TABLE_MAP: Record<string, string> = {
                BusinessPartners: 'OCRD', Items: 'OITM', Orders: 'ORDR',
                JournalEntries: 'OJDT', ContactEmployees: 'OCPR', Invoices: 'OINV',
                PurchaseInvoices: 'OPCH', ProfitCenters: 'OPRC', BusinessPartnerGroups: 'OCRG',
            };
            const tableName = TABLE_MAP[sapObject] ?? sapObject;
            try {
                const ufRes = await client.get('/UserFieldsMD', {
                    params: { $select: 'TableName,FieldID,Name', $top: 500 },
                    headers: { Cookie: cookieHeader },
                });
                const all: any[] = ufRes.data?.value || [];
                fields = all.filter(f => f.TableName === tableName).map(f => `U_${f.Name}`);
                source = 'UserFieldsMD';
                console.log(`[user-fields] UserFieldsMD: ${fields.length} campos para "${tableName}"`);
            } catch (e: any) {
                console.warn('[user-fields] UserFieldsMD falhou:', e.message);
            }
        }

        // Logout (best-effort)
        await client.post('/Logout', {}, { headers: { Cookie: cookieHeader } }).catch(() => {});

        return NextResponse.json({ success: true, fields, object: sapObject, entityType: entityTypeName, source });
    } catch (error: any) {
        const sapMsg = error?.response?.data?.error?.message?.value || error.message;
        console.error('[user-fields] error fatal:', sapMsg);
        // Não bloqueia o mapeamento — retorna lista vazia
        return NextResponse.json({ success: true, fields: [], message: sapMsg });
    }
}
