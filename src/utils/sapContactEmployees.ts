/**
 * Leitura da coleção de contatos (OCPR) no Service Layer.
 * $expand=ContactEmployees em BusinessPartners costuma retornar 400 em vários SAP B1;
 * o sub-recurso /ContactEmployees tende a ser suportado.
 */

/**
 * O Service Layer rejeita e-mail vazio ou inválido (-1000).
 * No JSON de escrita use **E_Mail** (OData); E_MailL costuma falhar em PATCH/POST em vários ambientes.
 * Só retorna string quando o texto parece um e-mail válido (após trim).
 */
export function sanitizeContactEmployeeEmail(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    const s = String(raw).trim();
    if (!s) return undefined;
    if (s.length > 254) return undefined;
    // Evita "N/A", "-", texto sem @, etc.
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!looksLikeEmail.test(s)) return undefined;
    return s;
}

export type FetchContactEmployeesResult = {
    contacts: any[];
    /** Parceiro inexistente ou erro ao ler cabeçalho do BP */
    businessPartnerError?: string;
    /** BP existe, mas nem /ContactEmployees nem $expand retornaram lista */
    contactListWarning?: string;
};

/** Extrai array de contatos de respostas OData v2/v3/v4. */
export function extractContactEmployeesArray(j: unknown): any[] {
    if (j == null) return [];
    if (Array.isArray(j)) return j;
    if (typeof j !== 'object') return [];
    const o = j as Record<string, unknown>;
    if (Array.isArray(o.value)) return o.value;
    if (Array.isArray(o.results)) return o.results;
    const d = o.d as Record<string, unknown> | undefined;
    if (d && Array.isArray(d.results)) return d.results as any[];
    if (Array.isArray(o.ContactEmployees)) return o.ContactEmployees as any[];
    return [];
}

export async function fetchContactEmployeesForBusinessPartner(
    serviceLayerUrl: string,
    cookieHeader: string,
    cardCode: string
): Promise<FetchContactEmployeesResult> {
    const base = serviceLayerUrl.replace(/\/$/, '');
    const cc = cardCode.replace(/'/g, "''");
    const headers = { Cookie: cookieHeader };

    const subUrl = `${base}/BusinessPartners('${cc}')/ContactEmployees?$top=500`;
    const subRes = await fetch(subUrl, { headers });
    if (subRes.ok) {
        try {
            const j = await subRes.json();
            let contacts = extractContactEmployeesArray(j);
            if (contacts.length === 0) {
                const expandFull = await fetch(
                    `${base}/BusinessPartners('${cc}')?$expand=ContactEmployees`,
                    { headers }
                );
                if (expandFull.ok) {
                    try {
                        const j2 = await expandFull.json();
                        contacts = extractContactEmployeesArray(j2.ContactEmployees ?? j2);
                        if (contacts.length === 0 && Array.isArray((j2 as any)?.ContactEmployees)) {
                            contacts = (j2 as any).ContactEmployees;
                        }
                    } catch {
                        /* ignore */
                    }
                }
            }
            return { contacts };
        } catch {
            return { contacts: [], businessPartnerError: 'Resposta inválida em /ContactEmployees.' };
        }
    }

    const expandRes = await fetch(
        `${base}/BusinessPartners('${cc}')?$select=CardCode&$expand=ContactEmployees`,
        { headers }
    );
    if (expandRes.ok) {
        try {
            const j = await expandRes.json();
            let contacts = extractContactEmployeesArray(j.ContactEmployees ?? j);
            if (contacts.length === 0 && Array.isArray(j?.ContactEmployees)) contacts = j.ContactEmployees;
            return { contacts };
        } catch {
            return { contacts: [], businessPartnerError: 'Resposta inválida com $expand=ContactEmployees.' };
        }
    }

    const bpOnly = await fetch(`${base}/BusinessPartners('${cc}')?$select=CardCode`, { headers });
    if (!bpOnly.ok) {
        let snippet = '';
        try {
            snippet = (await bpOnly.text()).slice(0, 200);
        } catch {
            /* ignore */
        }
        return {
            contacts: [],
            businessPartnerError: `BusinessPartners('${cardCode}') indisponível (${bpOnly.status}). ${snippet}`,
        };
    }

    return {
        contacts: [],
        contactListWarning:
            'Parceiro encontrado, mas a lista de contatos não pôde ser lida neste Service Layer; deduplicação por nome/LineNum ignorada.',
    };
}

/**
 * GET completo em BusinessPartners — quando /ContactEmployees devolve vazio ou falha,
 * o corpo do BP muitas vezes ainda traz ContactEmployees.
 */
export async function fetchContactEmployeesViaFullPartnerGet(
    serviceLayerUrl: string,
    cookieHeader: string,
    cardCode: string
): Promise<any[] | null> {
    const base = serviceLayerUrl.replace(/\/$/, '');
    const cc = cardCode.replace(/'/g, "''");
    const res = await fetch(`${base}/BusinessPartners('${cc}')`, {
        headers: { Cookie: cookieHeader },
    });
    if (!res.ok) return null;
    try {
        const j = await res.json();
        const fromProp = extractContactEmployeesArray(j.ContactEmployees ?? j);
        if (fromProp.length > 0) return fromProp;
        if (Array.isArray(j?.ContactEmployees)) return j.ContactEmployees;
        return null;
    } catch {
        return null;
    }
}
