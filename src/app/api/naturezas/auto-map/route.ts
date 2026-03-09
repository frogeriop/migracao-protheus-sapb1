import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');
async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

// ── Normalização e stemming para português ────────────────────────────────────
function normalize(str: string): string {
    return (str || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const STOP_PT = new Set([
    'de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'no', 'na',
    'com', 'por', 'para', 'ou', 'ao', 'as', 'os', 'se', 'que', 'um',
    'uma', 'uns', 'umas', 'the', 'of', 'and', 'or', 'in', 'on',
]);

/**
 * Stemming simples para português.
 * Remove sufixos flexionais mais comuns para que
 * "DESPESA / DESPESAS", "FORNECEDOR / FORNECEDORES", "PAGAMENTO / PAGAMENTOS"
 * sejam tratados como a mesma raiz.
 */
function stemPT(word: string): string {
    return word
        .replace(/coes$/, 'c')          // situações → situac
        .replace(/cao$/, 'c')            // situação → situac
        .replace(/oes$/, 'o')            // remunerações → remunerao  (já foi tratado acima se termina -ões)
        .replace(/amentos$/, 'ament')
        .replace(/amento$/, 'ament')
        .replace(/imentos$/, 'iment')
        .replace(/imento$/, 'iment')
        .replace(/idades$/, 'idad')
        .replace(/idade$/, 'idad')
        .replace(/adores$/, 'ador')
        .replace(/eiros$/, 'eiro')
        .replace(/dores$/, 'dor')
        .replace(/ores$/, 'or')
        .replace(/ais$/, 'al')           // financiais → financal
        .replace(/eis$/, 'el')
        .replace(/veis$/, 'vel')         // variáveis → varivel
        .replace(/vel$/, 'vel')
        .replace(/veis$/, 'vel')
        .replace(/es$/, '')              // viagens → viag
        .replace(/as$/, 'a')
        .replace(/os$/, 'o')
        .replace(/s$/, '');              // plural genérico
}

/** Tokeniza e aplica stemming */
function tokenize(str: string): string[] {
    return normalize(str)
        .split(' ')
        // >= 2: permite siglas de 2 letras (RH, CS, TI, DP…)
        // stop words de 2 letras (de, em, no…) são removidas pelo STOP_PT
        .filter(w => w.length >= 2 && !STOP_PT.has(w));
}

function tokenSet(str: string): Set<string> {
    return new Set(tokenize(str));
}

function stemSet(str: string): Set<string> {
    return new Set(tokenize(str).map(stemPT));
}

/** Jaccard entre dois conjuntos */
function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (new Set([...a, ...b]).size);
}

/**
 * Normaliza o account_type do SAP para comparação.
 * Exemplos: 'at_Expense', 'at_expense', 'at_Revenues' → 'expense', 'revenues'
 */
function normalizeSapType(sapType: string): string {
    return (sapType || '').toLowerCase().replace(/^at_/, '');
}

/**
 * Determina a "classe" da natureza para correlação com tipo SAP.
 * Protheus SED010: ED_COND = 'R' → Receita; ED_COND = 'D' → Despesa
 */
function naturezaClass(edCond: string): 'expense' | 'revenue' | null {
    const v = edCond.trim().toUpperCase();
    if (v === 'D') return 'expense';
    if (v === 'R') return 'revenue';
    return null;
}

/**
 * Bônus de substring: verifica se alguma raiz de A está contida em alguma raiz de B
 * (ou vice-versa). Cobre casos como "PESSOAL" ∈ "DESPESAS DE PESSOAL".
 */
function substringBonus(stemsA: Set<string>, stemsB: Set<string>): number {
    // Só dispara quando uma raiz é substring PRÓPRIA da outra (tamanhos diferentes).
    // Tokens iguais já são contabilizados pelo Jaccard — não contar duas vezes.
    let found = false;
    for (const a of stemsA) {
        if (a.length < 4) continue;
        for (const b of stemsB) {
            if (a === b) continue;                       // igual → já no Jaccard
            if (b.includes(a) || a.includes(b)) { found = true; break; }
        }
        if (found) break;
    }
    return found ? 0.15 : 0;
}

// ── Abreviações corporativas comuns (pt-BR) ───────────────────────────────────
// Chave: sigla normalizada (minúscula sem acento)
// Valor: termos que a sigla pode representar (também normalizados)
const ABBREV_DICT: Record<string, string[]> = {
    'mkt': ['marketing'],
    'rh': ['recursos', 'humano', 'pessoal'],
    'ti': ['tecnologia', 'informacao', 'informatica', 'sistema'],
    'cs': ['customer', 'sucesso', 'suporte', 'comercial'],
    'dp': ['departamento', 'pessoal'],
    'pd': ['pesquisa', 'desenvolvimento'],
    'ped': ['pesquisa', 'desenvolvimento'],
    'adm': ['administrativo', 'administracao'],
    'fin': ['financeiro', 'financas'],
    'com': ['comercial'],
    'log': ['logistica'],
    'eng': ['engenharia'],
    'ven': ['vendas'],
    'jur': ['juridico'],
    'pro': ['producao'],
    'ope': ['operacional', 'operacoes'],
    'seg': ['seguranca', 'seguros'],
    'cont': ['contabilidade', 'contabil'],
    'rec': ['receita', 'recebimento'],
    'desp': ['despesa'],
    'cfo': ['financeiro', 'financas'],
    'cto': ['tecnologia'],
    'cmo': ['marketing'],
    'coo': ['operacional'],
    'tic': ['tecnologia', 'informacao', 'comunicacao'],
    'grc': ['governanca', 'risco', 'compliance'],
    'sst': ['saude', 'seguranca', 'trabalho'],
    'qsms': ['qualidade', 'saude', 'meio', 'seguranca'],
};

/**
 * Bônus por abreviação/acrônimo entre tokens de A e tokens de B.
 *
 * Mecanismos (do mais fraco para o mais forte):
 *   1. Prefix (≥3 chars): "adm" → "administrativo", "fin" → "financeiro"   → +0.18
 *   2. Dicionário: "MKT" → "marketing", "RH" → "recursos humanos"           → +0.25
 *   3. Acrônimo: "CS" = iniciais de ["Customer","Success"]                   → +0.30
 *
 * Retorna o bônus máximo encontrado (não acumula entre mecanismos).
 */
function abbrevBonus(tokA: string[], tokB: string[]): number {
    let best = 0;

    // ── 1. Prefix matching ─────────────────────────────────────────────────────
    for (const a of tokA) {
        for (const b of tokB) {
            if (a === b) continue;
            const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
            if (shorter.length >= 3 && longer.startsWith(shorter)) {
                best = Math.max(best, 0.18);
            }
        }
    }

    // ── 2. Dicionário de abreviações ───────────────────────────────────────────
    const checkDict = (shortToks: string[], longToks: string[]) => {
        for (const t of shortToks) {
            const expansions = ABBREV_DICT[t];
            if (!expansions) continue;
            for (const exp of expansions) {
                if (longToks.some(b => b === exp || b.startsWith(exp) || exp.startsWith(b))) {
                    best = Math.max(best, 0.25);
                }
            }
        }
    };
    checkDict(tokA, tokB);
    checkDict(tokB, tokA);

    // ── 3. Acrônimo: sigla = iniciais dos tokens do outro lado ─────────────────
    const checkAcronym = (candidates: string[], wordList: string[]) => {
        if (wordList.length < 2) return; // acrônimo precisa de ao menos 2 palavras
        const initials = wordList.map(w => w[0] ?? '').join('');
        for (const c of candidates) {
            if (c.length >= 2 && c.length <= 6 && c === initials) {
                best = Math.max(best, 0.30);
            }
        }
    };
    checkAcronym(tokA, tokB);
    checkAcronym(tokB, tokA);

    return best;
}

/**
 * Score total de similaridade entre uma natureza e uma conta SAP.
 *
 * Componentes:
 *   textScore = 60% Jaccard-stemmed + 40% Jaccard-exato
 *              (valoriza tanto raiz quanto forma exata)
 *   + substringBonus  (até +0.15 quando uma raiz contém outra)
 *   + abbrevBonus     (até +0.30 por abreviações, siglas e acrônimos)
 *   + typeAdjust      (-0.10 mismatch / +0.35 match de tipo Despesa/Receita)
 *
 * Resultado clamped em [0, 1].
 */
function score(naturezaDesc: string, edCond: string, sapName: string, sapType: string): number {
    const tokExN = tokenize(naturezaDesc); // lista — preserva ordem para acrônimo
    const tokExS = tokenize(sapName);
    const stemN = stemSet(naturezaDesc);
    const stemS = stemSet(sapName);

    if (stemN.size === 0 || stemS.size === 0) return 0;

    const jExact = jaccard(new Set(tokExN), new Set(tokExS)); // tokens exatos
    const jStem = jaccard(stemN, stemS);                      // tokens com stemming
    const textScore = 0.4 * jExact + 0.6 * jStem;                // score textual híbrido

    const subBonus = substringBonus(stemN, stemS);              // substring containment
    const abrBonus = abbrevBonus(tokExN, tokExS);               // abreviações / acrônimos

    // Ajuste por tipo Despesa/Receita ↔ at_Expenses/at_revenues
    const natClass = naturezaClass(edCond);
    const sapNorm = normalizeSapType(sapType);
    let typeAdjust = 0;
    if (natClass === 'expense') {
        if (sapNorm.startsWith('expense')) typeAdjust = +0.35;
        if (sapNorm === 'revenues') typeAdjust = -0.10;
    } else if (natClass === 'revenue') {
        if (sapNorm === 'revenues') typeAdjust = +0.35;
        if (sapNorm.startsWith('expense')) typeAdjust = -0.10;
    }

    // Retorna o score BRUTO (pode ultrapassar 1.0).
    // O clamp só ocorre na exibição final (campo confidence).
    // Manter o score bruto é essencial para que tokens diferenciadores
    // (ex: DESENVOLVEDORES vs SUPORTE vs MKT) quebrem empates entre contas
    // que já atingiram 1.0 pelos tokens comuns + typeAdjust.
    return Math.max(0, textScore + subBonus + abrBonus + typeAdjust);
}

// GET /api/naturezas/auto-map  — gera sugestões sem salvar
// Query params: onlyUnmapped=true|false
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const onlyUnmapped = searchParams.get('onlyUnmapped') !== 'false';

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        // Busca todas as naturezas — inclui ed_cond (D=Despesa, R=Receita)
        let natQuery = supabase
            .from('sed010')
            .select('ed_codigo, ed_filial, ed_descric, ed_cond, ed_conta, sap_account_code, sap_account_name')
            .or('d_e_l_e_t_.eq.,d_e_l_e_t_.eq. ')
            .order('ed_codigo', { ascending: true });

        if (onlyUnmapped) {
            natQuery = natQuery.or('sap_account_code.is.null,sap_account_code.eq.');
        }

        const { data: naturezas, error: natError } = await natQuery;
        if (natError) throw new Error(natError.message);

        // Busca contas SAP excluindo at_other (contas genéricas não mapeáveis a naturezas)
        // O SAP SL pode gravar 'at_Other', 'at_other', etc. — filtramos case-insensitive via ilike
        const { data: accounts, error: accError } = await supabase
            .from('sap_chart_of_accounts')
            .select('code, name, account_type, father_account')
            .not('account_type', 'ilike', 'at_other');
        if (accError) throw new Error(accError.message);

        if (!accounts || accounts.length === 0) {
            return NextResponse.json({
                success: false,
                message: 'Nenhuma conta importada em sap_chart_of_accounts. Importe o Plano de Contas SAP primeiro.',
            }, { status: 400 });
        }

        // ── Pré-particiona contas por tipo (filtro hard) ─────────────────────────
        // Natureza D (Despesa)  → SOMENTE at_Expenses (startsWith 'expense' cobre at_Expense e at_Expenses)
        // Natureza R (Receita)  → SOMENTE at_revenues
        // Natureza sem ED_COND  → todos os tipos já sem at_other
        const expenseAccounts = accounts.filter(
            (a: any) => normalizeSapType(a.account_type || '').startsWith('expense')
        );
        const revenueAccounts = accounts.filter(
            (a: any) => normalizeSapType(a.account_type || '') === 'revenues'
        );

        // Para cada natureza, calcula o melhor match dentro do subconjunto correto
        const suggestions = (naturezas || []).map((nat: any) => {
            // ED_COND: 'D' = Despesa → pool de despesas
            //          'R' = Receita → pool de receitas
            //          vazio        → pool completo (sem at_other)
            const edCond = (nat.ed_cond || '').trim().toUpperCase();

            let candidatePool: any[];
            if (edCond === 'D') candidatePool = expenseAccounts;
            else if (edCond === 'R') candidatePool = revenueAccounts;
            else candidatePool = accounts; // fallback: todos

            let bestAccount = null;
            let bestScore = 0;

            for (const acc of candidatePool) {
                // Passa edCond apenas para o bônus textual de tipo (ainda útil no fallback)
                const s = score(nat.ed_descric || '', edCond, acc.name || '', acc.account_type || '');
                if (s > bestScore) {
                    bestScore = s;
                    bestAccount = acc;
                }
            }

            // Só sugere se score mínimo for atingido (evita sugestões aleatórias).
            // bestScore é BRUTO (pode ser > 1.0) — clamp apenas na exibição.
            const MIN_SCORE = 0.08;
            return {
                ed_codigo: nat.ed_codigo,
                ed_filial: nat.ed_filial,
                ed_descric: nat.ed_descric,
                ed_debcred: edCond, // 'D' = Despesa, 'R' = Receita
                ed_conta: nat.ed_conta,
                current_account: nat.sap_account_code || null,
                current_name: nat.sap_account_name || null,
                suggested_code: bestScore >= MIN_SCORE ? bestAccount?.code : null,
                suggested_name: bestScore >= MIN_SCORE ? bestAccount?.name : null,
                suggested_type: bestScore >= MIN_SCORE ? bestAccount?.account_type : null,
                // Clamp somente aqui — raw score pode ser > 1.0 por design
                confidence: bestScore >= MIN_SCORE ? Math.min(100, Math.round(bestScore * 100)) : 0,
            };
        });

        const withSuggestions = suggestions
            .filter((s: any) => s.suggested_code !== null)
            .sort((a: any, b: any) => b.confidence - a.confidence); // maior % primeiro

        return NextResponse.json({
            success: true,
            total: suggestions.length,
            withSuggestion: withSuggestions.length,
            suggestions: withSuggestions,
        });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

// POST /api/naturezas/auto-map  — aplica os mapeamentos confirmados
// body: { mappings: [{ ed_codigo, ed_filial, sap_account_code, sap_account_name }] }
export async function POST(request: Request) {
    try {
        const { mappings } = await request.json();

        if (!Array.isArray(mappings) || mappings.length === 0) {
            return NextResponse.json({ success: false, message: 'Nenhum mapeamento enviado.' }, { status: 400 });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        let saved = 0;
        const errors: string[] = [];

        for (const m of mappings) {
            const { error } = await supabase
                .from('sed010')
                .update({
                    sap_account_code: m.sap_account_code,
                    sap_account_name: m.sap_account_name,
                    updated_at: new Date().toISOString(),
                })
                .eq('ed_codigo', m.ed_codigo)
                .eq('ed_filial', m.ed_filial);

            if (error) errors.push(`${m.ed_codigo}: ${error.message}`);
            else saved++;
        }

        return NextResponse.json({ success: true, saved, errors });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
