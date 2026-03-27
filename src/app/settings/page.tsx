'use client';

import { useEffect, useState } from 'react';
import { Database, HardDrive, FolderOutput, TableProperties, ArrowRight, BookOpen, FileSpreadsheet, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { ConnectionCard } from '@/components/ui/ConnectionCard';
import { useConfig } from '@/hooks/useConfig';
import { ProtheusConfig, SupabaseConfig, SapConfig } from '@/types/config';

export default function SettingsPage() {
    const { config, loading, updateProtheusConfig, updateSupabaseConfig, updateSapConfig, saveConfig } = useConfig();
    const [protheusConfig, setProtheusConfig] = useState<ProtheusConfig | null>(null);
    const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig | null>(null);
    const [sapConfig, setSapConfig] = useState<SapConfig | null>(null);
    const [activeSourceTab, setActiveSourceTab] = useState<'protheus' | 'excel'>('protheus');

    // Excel Validation State
    const [excelFile, setExcelFile] = useState<File | null>(null);
    const [isValidatingExcel, setIsValidatingExcel] = useState(false);
    const [excelColumns, setExcelColumns] = useState<string[]>([]);
    const [excelError, setExcelError] = useState<string | null>(null);

    // Migration Entities
    const [entities, setEntities] = useState<any[]>([]);
    const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

    useEffect(() => {
        if (config) {
            setProtheusConfig(config.protheus);
            setSupabaseConfig(config.supabase);
            setSapConfig(config.sap);
        }
        fetchEntities();
    }, [config]);

    const fetchEntities = async () => {
        try {
            const res = await fetch('/api/migration/entities');
            const result = await res.json();
            if (result.success) {
                setEntities(result.data || []);
                if (result.data?.length > 0 && !selectedEntityId) {
                    setSelectedEntityId(result.data[0].id);
                }
            }
        } catch (e) {
            console.error('Error fetching entities:', e);
        }
    };

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
        alert('Configurações salvas com sucesso!');
    };

    const handleValidateExcel = async () => {
        if (!excelFile || !selectedEntityId) return;
        setIsValidatingExcel(true);
        setExcelColumns([]);
        setExcelError(null);
        try {
            const formData = new FormData();
            formData.append('file', excelFile);
            formData.append('entityId', selectedEntityId);
            formData.append('dryRun', 'true');

            const res = await fetch('/api/migration/excel', {
                method: 'POST',
                body: formData
            });

            const json = await res.json();
            if (json.success) {
                setExcelColumns(json.columns || []);
                // Refetch entities to show the newly linked file
                fetchEntities();
            } else {
                setExcelError(json.message);
            }
        } catch (e: any) {
            console.error('Excel validation error:', e);
            setExcelError('Erro de conexão ao validar Excel: ' + e.message);
        } finally {
            setIsValidatingExcel(false);
        }
    };

    const handleUnlinkFile = async (entityId: string) => {
        if (!confirm('Tem certeza que deseja desvincular o arquivo desta tabela?')) return;

        try {
            const res = await fetch('/api/migration/entities', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: entityId, source_file_path: null })
            });

            const json = await res.json();
            if (json.success) {
                fetchEntities();
                setExcelFile(null);
                setExcelColumns([]);
            } else {
                alert('Erro ao desvincular: ' + json.message);
            }
        } catch (e: any) {
            console.error('Unlink error:', e);
            alert('Erro de conexão ao desvincular: ' + e.message);
        }
    };

    if (loading) return <div>Carregando...</div>;
    if (!protheusConfig || !supabaseConfig || !sapConfig) return <div>Erro ao carregar configurações.</div>;

    const selectedEntity = entities.find(e => e.id === selectedEntityId);

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


                {/* SOURCE SECTION WITH TABS */}
                <section>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                        <h2 style={{ fontSize: '1.25rem', color: 'var(--foreground)' }}>1. Origem</h2>
                        <div style={{ display: 'flex', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '0.25rem' }}>
                            <button
                                onClick={() => setActiveSourceTab('protheus')}
                                style={{
                                    padding: '0.5rem 1rem',
                                    borderRadius: '6px',
                                    border: 'none',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    fontWeight: 600,
                                    backgroundColor: activeSourceTab === 'protheus' ? 'var(--primary)' : 'transparent',
                                    color: activeSourceTab === 'protheus' ? '#fff' : 'var(--secondary)',
                                    transition: 'all 0.2s'
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <Database size={14} /> Totvs Protheus
                                </div>
                            </button>
                            <button
                                onClick={() => setActiveSourceTab('excel')}
                                style={{
                                    padding: '0.5rem 1rem',
                                    borderRadius: '6px',
                                    border: 'none',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    fontWeight: 600,
                                    backgroundColor: activeSourceTab === 'excel' ? 'var(--primary)' : 'transparent',
                                    color: activeSourceTab === 'excel' ? '#fff' : 'var(--secondary)',
                                    transition: 'all 0.2s'
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <FileSpreadsheet size={14} /> Planilha Excel
                                </div>
                            </button>
                        </div>
                    </div>

                    {activeSourceTab === 'protheus' ? (
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
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '1rem' }}>
                            {/* Left Sidebar: Entity Selection */}
                            <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '500px', overflowY: 'auto' }}>
                                <h4 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--secondary)' }}>Tabelas de Importação</h4>
                                {entities.map(entity => (
                                    <button
                                        key={entity.id}
                                        onClick={() => {
                                            setSelectedEntityId(entity.id);
                                            setExcelFile(null);
                                            setExcelColumns([]);
                                        }}
                                        style={{
                                            padding: '0.75rem',
                                            borderRadius: '8px',
                                            border: '1px solid ' + (selectedEntityId === entity.id ? 'var(--primary)' : 'var(--card-border)'),
                                            backgroundColor: selectedEntityId === entity.id ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                                            color: selectedEntityId === entity.id ? 'var(--primary)' : 'var(--foreground)',
                                            textAlign: 'left',
                                            cursor: 'pointer',
                                            fontSize: '0.9rem',
                                            transition: 'all 0.2s',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between'
                                        }}
                                    >
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span style={{ fontWeight: selectedEntityId === entity.id ? 600 : 400 }}>{entity.name}</span>
                                            {entity.source_file_path && (
                                                <span style={{ fontSize: '0.75rem', color: selectedEntityId === entity.id ? 'var(--primary)' : 'var(--secondary)', marginTop: '2px' }}>
                                                    {entity.source_file_path}
                                                </span>
                                            )}
                                        </div>
                                        {selectedEntityId === entity.id && <ArrowRight size={14} />}
                                    </button>
                                ))}
                            </div>

                            {/* Right Content: Upload Area */}
                            <div className="card" style={{ padding: '1.5rem' }}>
                                {selectedEntity ? (
                                    <>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
                                            <div style={{ backgroundColor: 'rgba(34, 197, 94, 0.1)', padding: '0.75rem', borderRadius: '8px', color: '#22c55e' }}>
                                                <FileSpreadsheet size={24} />
                                            </div>
                                            <div>
                                                <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Planilha de {selectedEntity.name}</h3>
                                                <p style={{ color: 'var(--secondary)', fontSize: '0.9rem' }}>
                                                    Formatos aceitos: .xlsx, .csv. Sincroniza com: <code>{selectedEntity.staging_table}</code>
                                                    {selectedEntity.source_file_path && (
                                                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '4px', fontWeight: 500, color: 'var(--primary)' }}>
                                                            <span>Arquivo vinculado: {selectedEntity.source_file_path}</span>
                                                            <button 
                                                                onClick={() => handleUnlinkFile(selectedEntity.id)}
                                                                style={{ 
                                                                    background: 'none', 
                                                                    border: 'none', 
                                                                    color: '#ff4d4f', 
                                                                    fontSize: '0.75rem', 
                                                                    cursor: 'pointer',
                                                                    textDecoration: 'underline',
                                                                    padding: 0
                                                                }}
                                                            >
                                                                (Desvincular)
                                                            </button>
                                                        </span>
                                                    )}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="input-group" style={{ padding: '3rem 2rem', border: '2px dashed var(--card-border)', borderRadius: '12px', textAlign: 'center', backgroundColor: 'rgba(255,255,255,0.01)' }}>
                                            <input
                                                key={selectedEntityId}
                                                type="file"
                                                accept=".xlsx, .xls, .csv"
                                                id="excel-upload"
                                                hidden
                                                onChange={e => setExcelFile(e.target.files?.[0] || null)}
                                                onClick={e => (e.target as any).value = null}
                                            />
                                            <label htmlFor="excel-upload" style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                                                <FolderOutput size={32} style={{ color: 'var(--secondary)', marginBottom: '0.5rem' }} />
                                                <span style={{ fontWeight: 500 }}>{excelFile ? excelFile.name : 'Clique para selecionar ou arraste o arquivo'}</span>
                                                <span style={{ fontSize: '0.75rem', color: 'var(--secondary)' }}>Máximo 5MB • Validação contra estrutura `{selectedEntity.target_object}`</span>
                                            </label>
                                        </div>

                                        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '1rem', alignItems: 'center' }}>
                                            <button
                                                className="btn btn-primary"
                                                onClick={handleValidateExcel}
                                                disabled={isValidatingExcel || !excelFile}
                                            >
                                                {isValidatingExcel ? (
                                                    <>
                                                        <Loader2 size={18} className="animate-spin" style={{ marginRight: '0.5rem' }} /> Validando...
                                                    </>
                                                ) : 'Validar Estrutura'}
                                            </button>
                                            {excelFile && <button className="btn btn-secondary" onClick={() => { setExcelFile(null); setExcelError(null); }}>Remover</button>}
                                        </div>

                                        {excelError && (
                                            <div style={{ marginTop: '1.5rem', padding: '1rem', backgroundColor: 'rgba(239, 68, 68, 0.05)', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', fontSize: '0.9rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                                                    <AlertCircle size={18} style={{ marginTop: '2px' }} />
                                                    <div style={{ flex: 1 }}>
                                                        <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Erro na Validação</p>
                                                        <p>{excelError}</p>
                                                        <div style={{ marginTop: '1rem' }}>
                                                            <a 
                                                                href={`/api/migration/template?entityId=${selectedEntityId}`}
                                                                download
                                                                className="btn btn-secondary"
                                                                style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }}
                                                            >
                                                                Baixar Modelo de Planilha Aceito
                                                            </a>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {excelColumns.length > 0 && (
                                            <div style={{ marginTop: '2rem', padding: '1.5rem', backgroundColor: 'rgba(34, 197, 94, 0.05)', borderRadius: '8px', border: '1px solid rgba(34, 197, 94, 0.2)' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#22c55e', marginBottom: '1rem', fontWeight: 600 }}>
                                                    <CheckCircle size={18} /> Planilha Validada com Sucesso
                                                </div>
                                                <p style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>Colunas detectadas ({excelColumns.length}):</p>
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                                    {excelColumns.map(col => (
                                                        <span key={col} style={{ fontSize: '0.75rem', padding: '0.25rem 0.6rem', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '4px', border: '1px solid var(--card-border)' }}>
                                                            {col}
                                                        </span>
                                                    ))}
                                                </div>
                                                <div style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: 'var(--secondary)' }}>
                                                    <AlertCircle size={14} style={{ marginRight: '0.25rem', verticalAlign: 'middle' }} />
                                                    A estrutura está correta. O arquivo <code>{selectedEntity.source_file_path || excelFile?.name}</code> foi vinculado para futuras importações.
                                                </div>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--secondary)', minHeight: '300px' }}>
                                        Selecione uma tabela na coluna da esquerda para realizar a importação.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
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
