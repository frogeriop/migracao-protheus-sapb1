/** Helpers compartilhados entre orderLineTemplates e resultCenterDistribution (SE1010). */

/**
 * Converte texto numérico (Protheus/BR: "5.208,89" ou "480") para string aceita em expressões JS.
 * Sem isso, "5.208,89" virava "5.208.89" (dois pontos) e a proporção nas fórmulas ficava errada.
 */
export function normalizeNumericStringForFormula(raw: string): string {
    let t = raw.trim().replace(/\s/g, '');
    if (!t) return '0';
    // Formato BR típico: 1.234.567,89
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(t)) {
        return t.replace(/\./g, '').replace(',', '.');
    }
    // 1234,56 (decimal com vírgula)
    if (/^\d+,\d+$/.test(t)) {
        return t.replace(',', '.');
    }
    // Milhares BR sem decimais visíveis: 5.208 → 5208
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
        return t.replace(/\./g, '');
    }
    // Tem vírgula e ponto: assumir BR (pontos = milhar)
    if (t.includes(',') && t.includes('.')) {
        return t.replace(/\./g, '').replace(',', '.');
    }
    // Só vírgula como separador decimal restante
    if (t.includes(',')) {
        return t.replace(/,/g, '.');
    }
    return t;
}

export function normalizeKey(name: string): string {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '');
}

export function substitutePlaceholdersNumeric(template: string, sourceRecord: any): string {
    return template.replace(/\{([^}]+)\}/g, (_: string, key: string) => {
        const val =
            sourceRecord[key] ??
            sourceRecord[key.toUpperCase()] ??
            sourceRecord[key.toLowerCase()] ??
            sourceRecord[normalizeKey(key)];
        if (val === undefined || val === null) return '0';
        if (typeof val === 'number' && Number.isFinite(val)) {
            return String(val);
        }
        return normalizeNumericStringForFormula(String(val));
    });
}

export function substitutePlaceholdersString(template: string, sourceRecord: any): string {
    return template.replace(/\{([^}]+)\}/g, (_: string, key: string) => {
        const val =
            sourceRecord[key] ??
            sourceRecord[key.toUpperCase()] ??
            sourceRecord[key.toLowerCase()] ??
            sourceRecord[normalizeKey(key)];
        if (val === undefined || val === null) return '';
        return String(val).trim();
    });
}

export function evalNumericExpression(expr: string): number {
    const cleaned = expr.replace(/\s/g, '').replace(/,/g, '.');
    if (!/^[\d+\-*/().]+$/.test(cleaned)) {
        throw new Error(`caracteres inválidos: ${expr}`);
    }
    return Function(`"use strict"; return (${cleaned})`)();
}

export function lineMonetaryAmount(L: Record<string, any>): number {
    if (L.LineTotal !== undefined && L.LineTotal !== null && !Number.isNaN(Number(L.LineTotal))) {
        return Number(L.LineTotal);
    }
    const q = Number(L.Quantity) || 1;
    const up = Number(L.UnitPrice);
    return q * up;
}
