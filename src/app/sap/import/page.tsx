'use client';

import { useState } from 'react';
import {
    Download, CheckCircle, XCircle, Loader2, RefreshCw,
    Building2, BookOpen, Target, LayoutGrid, Package
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type ModuleKey = 'business_places' | 'chart_of_accounts' | 'cost_centers' | 'items';
type ModuleStatus = 'idle' | 'running' | 'success' | 'error';

interface ModuleResult {
    total?: number;
    saved?: number;
    synthetic?: number;
    strategy?: string;
}

interface ModuleState {
    status: ModuleStatus;
    result?: ModuleResult;
    error?: string;
    duration?: number;
}

const MODULES: { key: ModuleKey; label: string; description: string; icon: any }[] = [
    {
        key: 'business_places',
        label: 'Filiais (Business Places)',
        description: 'CNPJ, endereço, depósito padrão, cód. tributários e SPED de cada filial.',
        icon: Building2,
    },
    {
        key: 'chart_of_accounts',
        label: 'Plano de Contas',
        description: 'Contas analíticas (nível máximo) com tipo, saldo e conta pai.',
        icon: BookOpen,
    },
    {
        key: 'cost_centers',
        label: 'Centros de Custo',
        description: 'Centros de custo analíticos (ProfitCenters) cadastrados no SAP.',
        icon: Target,
    },
    {
        key: 'items',
        label: 'Itens (OITM)',
        description: 'ItemCode, ItemName e SvcCode (OSvcCode). Usado para relacionar E1_XTPSRV → DocumentLines.ItemCode em Sales Orders.',
        icon: Package,
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────
export default function SapImportPage() {
    const [moduleStates, setModuleStates] = useState<Record<ModuleKey, ModuleState>>({
        business_places: { status: 'idle' },
        chart_of_accounts: { status: 'idle' },
        cost_centers: { status: 'idle' },
        items: { status: 'idle' },
    });
    const [globalRunning, setGlobalRunning] = useState(false);
    const [selected, setSelected] = useState<Set<ModuleKey>>(new Set(['business_places', 'chart_of_accounts', 'cost_centers', 'items']));

    const updateModule = (key: ModuleKey, patch: Partial<ModuleState>) => {
        setModuleStates(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    };

    // Importa módulos selecionados via endpoint unificado
    const handleImport = async (targets: ModuleKey[]) => {
        if (targets.length === 0) return;
        setGlobalRunning(true);
        targets.forEach(k => updateModule(k, { status: 'running', result: undefined, error: undefined }));

        const t0 = Date.now();
        try {
            const res = await fetch('/api/sap/import-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targets }),
            });
            const json = await res.json();
            const elapsed = Date.now() - t0;

            targets.forEach(key => {
                if (json.results?.[key]) {
                    updateModule(key, { status: 'success', result: json.results[key], duration: elapsed });
                } else if (json.errors?.[key]) {
                    updateModule(key, { status: 'error', error: json.errors[key] });
                } else if (!json.success) {
                    updateModule(key, { status: 'error', error: json.message || 'Erro desconhecido' });
                }
            });
        } catch (e: any) {
            targets.forEach(k => updateModule(k, { status: 'error', error: e.message }));
        } finally {
            setGlobalRunning(false);
        }
    };

    const toggleSelect = (key: ModuleKey) => {
        setSelected(prev => {
            const n = new Set(prev);
            n.has(key) ? n.delete(key) : n.add(key);
            return n;
        });
    };

    const allSelected = MODULES.every(m => selected.has(m.key));
    const toggleAll = () => {
        setSelected(allSelected ? new Set() : new Set(MODULES.map(m => m.key)));
    };

    // ─── UI helpers ─────────────────────────────────────────────────────────
    const StatusIcon = ({ status }: { status: ModuleStatus }) => {
        if (status === 'success') return <CheckCircle size={20} style={{ color: 'var(--success)' }} />;
        if (status === 'error') return <XCircle size={20} style={{ color: 'var(--error)' }} />;
        if (status === 'running') return <Loader2 size={20} className="animate-spin" style={{ color: 'var(--accent)' }} />;
        return <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid var(--secondary)', opacity: 0.4 }} />;
    };

    const StatusBadge = ({ status }: { status: ModuleStatus }) => {
        const map: Record<ModuleStatus, { label: string; color: string; bg: string }> = {
            idle: { label: 'Aguardando', color: 'var(--secondary)', bg: 'rgba(148,163,184,0.1)' },
            running: { label: 'Importando…', color: 'var(--accent)', bg: 'rgba(99,102,241,0.15)' },
            success: { label: 'Concluído', color: 'var(--success)', bg: 'rgba(34,197,94,0.12)' },
            error: { label: 'Erro', color: 'var(--error)', bg: 'rgba(239,68,68,0.12)' },
        };
        const { label, color, bg } = map[status];
        return (
            <span style={{ padding: '2px 10px', borderRadius: 99, fontSize: '0.75rem', fontWeight: 500, color, background: bg }}>
                {label}
            </span>
        );
    };

    return (
        <div className="container" style={{ maxWidth: 960 }}>
            <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <LayoutGrid size={28} style={{ color: 'var(--accent)' }} />
                Importar Dados SAP
            </h1>
            <p style={{ color: 'var(--secondary)', marginBottom: '2rem', fontSize: '0.95rem' }}>
                Sincroniza dados mestres do SAP Business One para tabelas locais no Supabase.
                Use login único — os três módulos rodam em paralelo.
            </p>

            {/* ── Módulos ── */}
            <div className="card" style={{ marginBottom: '1.5rem' }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                    <h2 style={{ fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        Módulos disponíveis
                    </h2>
                    <button
                        onClick={toggleAll}
                        style={{ fontSize: '0.8rem', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                    >
                        {allSelected ? 'Desselecionar todos' : 'Selecionar todos'}
                    </button>
                </div>

                {/* Lista de módulos */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {MODULES.map(({ key, label, description, icon: Icon }) => {
                        const state = moduleStates[key];
                        const isSelected = selected.has(key);

                        return (
                            <div
                                key={key}
                                onClick={() => !globalRunning && toggleSelect(key)}
                                style={{
                                    display: 'grid',
                                    gridTemplateColumns: '24px 1fr auto',
                                    gap: '1rem',
                                    alignItems: 'center',
                                    padding: '1rem 1.25rem',
                                    borderRadius: 10,
                                    border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--card-border)'}`,
                                    backgroundColor: isSelected ? 'rgba(99,102,241,0.05)' : 'transparent',
                                    cursor: globalRunning ? 'default' : 'pointer',
                                    transition: 'all 0.15s',
                                }}
                            >
                                {/* Ícone e seleção */}
                                <div style={{
                                    width: 20, height: 20, borderRadius: 5,
                                    border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--secondary)'}`,
                                    backgroundColor: isSelected ? 'var(--accent)' : 'transparent',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    flexShrink: 0,
                                }}>
                                    {isSelected && <CheckCircle size={13} color="#fff" />}
                                </div>

                                {/* Info */}
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                                        <Icon size={16} style={{ color: 'var(--accent)' }} />
                                        <strong style={{ fontSize: '0.95rem' }}>{label}</strong>
                                    </div>
                                    <div style={{ fontSize: '0.82rem', color: 'var(--secondary)' }}>{description}</div>

                                    {/* Resultado */}
                                    {state.status === 'success' && state.result && (
                                        <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--success)' }}>
                                            ✓ {state.result.saved} registros salvos
                                            {state.result.synthetic !== undefined && state.result.synthetic > 0 &&
                                                ` (${state.result.synthetic} sintéticos ignorados)`}
                                            {state.result.strategy && ` · estratégia: ${state.result.strategy}`}
                                            {state.duration && ` · ${(state.duration / 1000).toFixed(1)}s`}
                                        </div>
                                    )}
                                    {state.status === 'error' && (
                                        <div style={{ marginTop: '0.4rem', fontSize: '0.8rem', color: 'var(--error)' }}>
                                            ✕ {state.error}
                                        </div>
                                    )}
                                </div>

                                {/* Status */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                                    <StatusBadge status={state.status} />
                                    <StatusIcon status={state.status} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* ── Ações ── */}
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {/* Importar selecionados */}
                <button
                    className="btn btn-primary"
                    disabled={globalRunning || selected.size === 0}
                    onClick={() => handleImport(Array.from(selected))}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 200 }}
                >
                    {globalRunning
                        ? <Loader2 size={18} className="animate-spin" />
                        : <Download size={18} />
                    }
                    {globalRunning
                        ? 'Importando…'
                        : `Importar ${selected.size === MODULES.length ? 'Tudo' : `${selected.size} módulo(s)`}`
                    }
                </button>

                {/* Re-importar falhos */}
                {!globalRunning && Object.entries(moduleStates).some(([, s]) => s.status === 'error') && (
                    <button
                        className="btn"
                        onClick={() => handleImport(
                            (Object.entries(moduleStates) as [ModuleKey, ModuleState][])
                                .filter(([, s]) => s.status === 'error')
                                .map(([k]) => k)
                        )}
                        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                    >
                        <RefreshCw size={16} /> Retentar falhos
                    </button>
                )}
            </div>

            {/* ── Nota ── */}
            <div style={{ marginTop: '2rem', padding: '1rem', borderRadius: 8, backgroundColor: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.2)', fontSize: '0.82rem', color: 'var(--secondary)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--text)' }}>ℹ️ Como funciona</strong><br />
                Um único login SAP é realizado e os módulos selecionados rodam em paralelo.
                Os dados são armazenados nas tabelas <code>sap_business_places</code>, <code>sap_chart_of_accounts</code>, <code>sap_cost_centers</code> e <code>sap_items</code> no Supabase.<br />
                O plano de contas, centros de custo e itens são <em>recriados do zero</em> a cada importação.<br />
                🔗 <strong>sap_items</strong>: o campo <code>svc_code</code> (OSvcCode) é usado para relacionar <code>E1_XTPSRV</code> (TOTVS) com <code>DocumentLines.ItemCode</code> na migração de Sales Orders.
            </div>
        </div>
    );
}
