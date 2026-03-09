'use client';

import { ReactNode, useState } from 'react';
import { Save, CheckCircle, Wifi, AlertTriangle, Loader2 } from 'lucide-react';
import styles from './ConnectionCard.module.css';

interface ConnectionCardProps {
    title: string;
    description: string;
    icon: ReactNode;
    children: ReactNode;
    onTest: () => Promise<{ success: boolean; message: string }>;
    onSave: () => Promise<void>;
    status?: 'idle' | 'loading' | 'success' | 'error';
    statusMessage?: string;
}

export function ConnectionCard({
    title,
    description,
    icon,
    children,
    onTest,
    onSave,
    status = 'idle',
    statusMessage = ''
}: ConnectionCardProps) {
    const [testing, setTesting] = useState(false);
    const [saving, setSaving] = useState(false);
    const [localStatus, setLocalStatus] = useState<'idle' | 'loading' | 'success' | 'error'>(status);
    const [localMessage, setLocalMessage] = useState(statusMessage);

    const handleTest = async () => {
        setTesting(true);
        setLocalStatus('loading');
        setLocalMessage('Testando conexão...');

        try {
            const result = await onTest();
            setLocalStatus(result.success ? 'success' : 'error');
            setLocalMessage(result.message);
        } catch (error) {
            setLocalStatus('error');
            setLocalMessage('Erro ao testar conexão: ' + (error instanceof Error ? error.message : String(error)));
        } finally {
            setTesting(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await onSave();
            // Optionally show a toast or something
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={styles.card}>
            <div className={styles.header}>
                <div className={styles.iconWrapper}>{icon}</div>
                <div>
                    <h2 className={styles.title}>{title}</h2>
                    <p className={styles.description}>{description}</p>
                </div>
            </div>

            <div className={styles.content}>
                {children}
            </div>

            <div className={styles.footer}>
                <div className={styles.statusArea}>
                    {localStatus === 'loading' && (
                        <span className={`${styles.status} ${styles.loading}`}>
                            <Loader2 className={styles.spinner} size={16} /> Connecting...
                        </span>
                    )}
                    {localStatus === 'success' && (
                        <span className={`${styles.status} ${styles.success}`}>
                            <CheckCircle size={16} /> {localMessage}
                        </span>
                    )}
                    {localStatus === 'error' && (
                        <span className={`${styles.status} ${styles.error}`}>
                            <AlertTriangle size={16} /> {localMessage}
                        </span>
                    )}
                </div>

                <div className={styles.actions}>
                    <button
                        onClick={handleTest}
                        disabled={testing || saving}
                        className={`${styles.btn} ${styles.btnSecondary}`}
                    >
                        <Wifi size={18} />
                        Testar Conexão
                    </button>

                    <button
                        onClick={handleSave}
                        disabled={testing || saving}
                        className={`${styles.btn} ${styles.btnPrimary}`}
                    >
                        <Save size={18} />
                        Salvar
                    </button>
                </div>
            </div>
        </div>
    );
}
