'use client';

import { useEffect, useState } from 'react';
import { Database, HardDrive, FolderOutput, TableProperties, ArrowRight, BookOpen } from 'lucide-react';
import Link from 'next/link';
import { ConnectionCard } from '@/components/ui/ConnectionCard';
import { useConfig } from '@/hooks/useConfig';
import { ProtheusConfig, SupabaseConfig, SapConfig } from '@/types/config';

export default function SettingsPage() {
    const { config, loading, updateProtheusConfig, updateSupabaseConfig, updateSapConfig, saveConfig } = useConfig();
    const [protheusConfig, setProtheusConfig] = useState<ProtheusConfig | null>(null);
    const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig | null>(null);
    const [sapConfig, setSapConfig] = useState<SapConfig | null>(null);

    useEffect(() => {
        if (config) {
            setProtheusConfig(config.protheus);
            setSupabaseConfig(config.supabase);
            setSapConfig(config.sap);
        }
    }, [config]);

    // Handle Changes
    const handleProtheusChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!protheusConfig) return;
        const updated = { ...protheusConfig, [e.target.name]: e.target.value };
        setProtheusConfig(updated);
        updateProtheusConfig(updated);
    };

    const handleSupabaseChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!supabaseConfig) return;
        const updated = { ...supabaseConfig, [e.target.name]: e.target.value };
        setSupabaseConfig(updated);
        updateSupabaseConfig(updated);
    };

    const handleSapChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!sapConfig) return;
        const updated = { ...sapConfig, [e.target.name]: e.target.value };
        setSapConfig(updated);
        updateSapConfig(updated);
    };

    // Test Functions
    const testProtheus = async () => {
        if (!protheusConfig) return { success: false, message: 'Configuração inválida' };
        const res = await fetch('/api/connections/protheus', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(protheusConfig),
        });
        const data = await res.json();
        return { success: data.success, message: data.message };
    };

    const testSupabase = async () => {
        if (!supabaseConfig) return { success: false, message: 'Configuração inválida' };
        const res = await fetch('/api/connections/supabase', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(supabaseConfig),
        });
        const data = await res.json();
        return { success: data.success, message: data.message };
    };

    const testSap = async () => {
        if (!sapConfig) return { success: false, message: 'Configuração inválida' };
        const res = await fetch('/api/connections/sap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sapConfig),
        });
        const data = await res.json();
        return { success: data.success, message: data.message };
    };

    const handleSave = async () => {
        await saveConfig();
    };

    if (loading) return <div>Carregando...</div>;
    if (!protheusConfig || !supabaseConfig || !sapConfig) return <div>Erro ao carregar configurações.</div>;

    return (
        <div className="container" style={{ paddingBottom: '4rem' }}>
            <h1 className="page-title">Configurações Gerais</h1>
            <p style={{ color: 'var(--secondary)', marginBottom: '2rem' }}>
                Gerencie as conexões de Origem, Intermediário e Destino em um só lugar.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

                {/* AUXILIARY TABLES LINK */}
                <div className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: '4px solid var(--primary)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <div style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)', padding: '0.75rem', borderRadius: '8px', color: 'var(--primary)' }}>
                            <TableProperties size={24} />
                        </div>
                        <div>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.25rem' }}>Tabelas Auxiliares & Recursos</h3>
                            <p style={{ color: 'var(--secondary)', fontSize: '0.9rem' }}>
                                Gerencie tabelas de apoio como Municípios do IBGE e CNAEs (SAP).
                            </p>
                        </div>
                    </div>
                    <Link href="/settings/auxiliary" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
                        Acessar Recursos <ArrowRight size={16} style={{ marginLeft: '0.5rem' }} />
                    </Link>
                </div>

                {/* NATUREZAS SED010 LINK */}
                <div className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderLeft: '4px solid #8b5cf6' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <div style={{ backgroundColor: 'rgba(139, 92, 246, 0.1)', padding: '0.75rem', borderRadius: '8px', color: '#8b5cf6' }}>
                            <BookOpen size={24} />
                        </div>
                        <div>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.25rem' }}>Naturezas de Lançamento (SED010)</h3>
                            <p style={{ color: 'var(--secondary)', fontSize: '0.9rem' }}>
                                Importe a tabela SED010 do TOTVS e mapeie as contas contábeis do SAP Business One.
                            </p>
                        </div>
                    </div>
                    <Link href="/settings/naturezas" className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
                        Gerenciar Naturezas <ArrowRight size={16} style={{ marginLeft: '0.5rem' }} />
                    </Link>
                </div>

                {/* PROTHEUS SECTION */}
                <section>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem', color: 'var(--foreground)' }}>1. Origem: TOTVS Protheus</h2>
                    <ConnectionCard
                        title="Banco de Dados SQL Server"
                        description="Configure a conexão com o banco de dados do TOTVS Protheus."
                        icon={<Database size={24} />}
                        onTest={testProtheus}
                        onSave={handleSave}
                    >
                        <div className="input-group">
                            <label className="label">Servidor</label>
                            <input className="input" name="server" value={protheusConfig.server} onChange={handleProtheusChange} placeholder="Ex: localhost" />
                        </div>
                        <div className="input-group">
                            <label className="label">Banco de Dados</label>
                            <input className="input" name="database" value={protheusConfig.database} onChange={handleProtheusChange} placeholder="Ex: PROTHEUS_DATA" />
                        </div>
                        <div className="input-group">
                            <label className="label">Usuário</label>
                            <input className="input" name="user" value={protheusConfig.user} onChange={handleProtheusChange} placeholder="sa" />
                        </div>
                        <div className="input-group">
                            <label className="label">Senha</label>
                            <input className="input" name="password" type="password" value={protheusConfig.password} onChange={handleProtheusChange} />
                        </div>
                        <div className="input-group">
                            <label className="label">Porta</label>
                            <input className="input" name="port" type="number" value={protheusConfig.port} onChange={handleProtheusChange} placeholder="1433" />
                        </div>
                    </ConnectionCard>
                </section>

                {/* SUPABASE SECTION */}
                <section>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem', color: 'var(--foreground)' }}>2. Intermediário: Supabase</h2>
                    <ConnectionCard
                        title="Supabase Database"
                        description="Configure a conexão com o banco de dados intermediário Supabase."
                        icon={<HardDrive size={24} />}
                        onTest={testSupabase}
                        onSave={handleSave}
                    >
                        <div className="input-group">
                            <label className="label">Project URL</label>
                            <input className="input" name="url" value={supabaseConfig.url} onChange={handleSupabaseChange} placeholder="https://xyz.supabase.co" />
                        </div>
                        <div className="input-group">
                            <label className="label">Anon Key / Service Role Key</label>
                            <input className="input" name="key" type="password" value={supabaseConfig.key} onChange={handleSupabaseChange} placeholder="eyJbh..." />
                        </div>
                    </ConnectionCard>
                </section>

                {/* SAP SECTION */}
                <section>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem', color: 'var(--foreground)' }}>3. Destino: SAP Business One</h2>
                    <ConnectionCard
                        title="SAP Service Layer"
                        description="Configure o acesso à Service Layer do SAP Business One."
                        icon={<FolderOutput size={24} />}
                        onTest={testSap}
                        onSave={handleSave}
                    >
                        <div className="input-group">
                            <label className="label">Service Layer URL</label>
                            <input className="input" name="serviceLayerUrl" value={sapConfig.serviceLayerUrl} onChange={handleSapChange} placeholder="https://myserver:50000/b1s/v1" />
                        </div>
                        <div className="input-group">
                            <label className="label">Banco de Dados (Company DB)</label>
                            <input className="input" name="companyDB" value={sapConfig.companyDB} onChange={handleSapChange} placeholder="SBO_COMMON" />
                        </div>
                        <div className="input-group">
                            <label className="label">Usuário</label>
                            <input className="input" name="userName" value={sapConfig.userName} onChange={handleSapChange} placeholder="manager" />
                        </div>
                        <div className="input-group">
                            <label className="label">Senha</label>
                            <input className="input" name="password" type="password" value={sapConfig.password} onChange={handleSapChange} />
                        </div>
                        <div className="input-group">
                            <label className="label">Language Code</label>
                            <input className="input" name="language" value={sapConfig.language} onChange={handleSapChange} placeholder="29" />
                        </div>
                    </ConnectionCard>
                </section>

            </div>
        </div>
    );
}
