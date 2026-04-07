export class TransformationUtils {

    /**
     * Parses a Brazilian address string into components.
     * Heuristics: 
     * - Looks for comma followed by digits (Number)
     * - Looks for "Rua", "Av", "Alameda" etc (Type)
     * - Everything else is Street match
     */
    static parseAddress(fullAddress: string): { type: string, street: string, number: string, complement: string } {
        if (!fullAddress) return { type: '', street: '', number: '', complement: '' };

        let remaining = fullAddress.trim();
        let type = '';
        let number = '';
        let complement = '';
        let street = '';

        // 1. Extract Type (Simple list)
        const types = ['RUA', 'R.', 'AVENIDA', 'AV.', 'ALAMEDA', 'AL.', 'TRAVESSA', 'TR.', 'RODOVIA', 'ESTRADA', 'PRACA', 'PC.'];
        const lowerAddr = remaining.toUpperCase();

        for (const t of types) {
            if (lowerAddr.startsWith(t + ' ')) {
                type = t.replace('.', ''); // Normalize
                remaining = remaining.substring(t.length).trim();
                break;
            }
        }

        // 2. Extract Number (Look for comma + digits, or "Nº" + digits)
        // Regex for ", 123" or " N 123" or just end of string digits
        const numberMatch = remaining.match(/(?:,|nº|n\.|num)\s*(\d+[a-zA-Z]?)/i) || remaining.match(/\s+(\d+)$/);

        if (numberMatch) {
            number = numberMatch[1];
            // Remove number and anything after it from street part, treat after as complement if valid
            const idx = remaining.indexOf(numberMatch[0]);

            // Extract complement (everything after number)
            // But verify if the match was at the end
            if (numberMatch.index !== undefined) {
                const afterNumber = remaining.substring(numberMatch.index + numberMatch[0].length).trim();
                complement = afterNumber.replace(/^[,\-\/\s]+/, ''); // Clean leading separators

                // Update remaining to be just the street part
                remaining = remaining.substring(0, numberMatch.index).trim();
            }
        } else {
            number = 'S/N';
        }

        // 3. Clean Street (remove trailing commas/hyphens)
        street = remaining.replace(/[,\-]+$/, '').trim();

        // If no type found, maybe inferred? For now leave blank if not explicit.

        return { type, street, number, complement };
    }

    /**
     * Sanitizes and formats Tax ID (CPF/CNPJ).
     * SAP B1 usually expects just numbers or specific separators depending on localization settings.
     * We will provide both Raw (digits only) and Formatted options.
     */
    static formatTaxId(cgc: string, format: 'digits' | 'pretty' = 'digits'): string {
        if (!cgc) return '';
        const digits = cgc.replace(/\D/g, '');

        if (format === 'digits') return digits;

        // Pretty format
        if (digits.length === 11) { // CPF
            return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        } else if (digits.length === 14) { // CNPJ
            return digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
        }

        return cgc; // Unknown
    }
}

/** Fuso usado para “hoje” (calendário comercial BR). */
const RUNTIME_TODAY_TZ = 'America/Sao_Paulo';

const RUNTIME_TODAY_PLACEHOLDER_RE = /^__RUNTIME_TODAY:([a-z0-9_]+)__$/i;

/** Data de hoje formatada (usado na integração após resolver o marcador). */
export function formatRuntimeToday(format?: string): string {
    const f = (format || 'iso').toLowerCase();
    const d = new Date();
    const isoLike = new Intl.DateTimeFormat('en-CA', {
        timeZone: RUNTIME_TODAY_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
    const [y, m, day] = isoLike.split('-');
    if (f === 'yyyymmdd') return `${y}${m}${day}`;
    if (f === 'br') return `${day}/${m}/${y}`;
    if (f === 'isodt' || f === 'datetime') return `${y}-${m}-${day}T00:00:00`;
    if (f === 'iso_z') return `${y}-${m}-${day}T00:00:00Z`;
    return `${y}-${m}-${day}`;
}

/**
 * Valor gravado no preview / payload até o POST de integração.
 * Na execução, `resolveRuntimeTodayPlaceholdersDeep` troca pela data real do dia.
 */
export function runtimeTodayPlaceholder(format?: string): string {
    const safe = String(format || 'iso')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '') || 'iso';
    return `__RUNTIME_TODAY:${safe}__`;
}

/** Substitui marcadores `__RUNTIME_TODAY:…__` em qualquer profundidade do JSON. */
export function resolveRuntimeTodayPlaceholdersDeep(root: unknown): void {
    if (root === null || root === undefined) return;
    if (Array.isArray(root)) {
        for (let i = 0; i < root.length; i++) {
            const v = root[i];
            if (typeof v === 'string') {
                const m = v.match(RUNTIME_TODAY_PLACEHOLDER_RE);
                if (m) (root as unknown[])[i] = formatRuntimeToday(m[1]);
            } else {
                resolveRuntimeTodayPlaceholdersDeep(v);
            }
        }
        return;
    }
    if (typeof root === 'object') {
        const o = root as Record<string, unknown>;
        for (const k of Object.keys(o)) {
            const v = o[k];
            if (typeof v === 'string') {
                const m = v.match(RUNTIME_TODAY_PLACEHOLDER_RE);
                if (m) o[k] = formatRuntimeToday(m[1]);
            } else {
                resolveRuntimeTodayPlaceholdersDeep(v);
            }
        }
    }
}
