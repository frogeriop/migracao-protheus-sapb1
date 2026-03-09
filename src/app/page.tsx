'use client';

import Link from 'next/link';
import { Database, FolderOutput, HardDrive, ArrowRight, Activity, Zap } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import { motion } from 'framer-motion';
import styles from './page.module.css';

const container = {
    hidden: { opacity: 0 },
    show: {
        opacity: 1,
        transition: {
            staggerChildren: 0.1
        }
    }
};

const item = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0 }
};

export default function Dashboard() {
    const { config, loading } = useConfig();

    const isConfigured = (obj: any) => {
        if (!obj) return false;
        return Object.values(obj).some(val => val !== '' && val !== 0 && val !== undefined);
    };

    return (
        <motion.div
            className={styles.container}
            initial="hidden"
            animate="show"
            variants={container}
        >
            <div className={styles.header}>
                <motion.h1
                    className={styles.title}
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5 }}
                >
                    Dashboard de Migração
                </motion.h1>
                <motion.p
                    className={styles.subtitle}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2, duration: 0.5 }}
                >
                    Bem-vindo ao sistema de migração Protheus para SAP Business One.
                    Configure as conexões e inicie o processo de migração com segurança e agilidade.
                </motion.p>
            </div>

            <motion.div className={styles.grid} variants={container}>
                {/* Protheus Card */}
                <Link href="/settings/protheus">
                    <motion.div className={styles.card} variants={item} whileHover={{ y: -5 }}>
                        <div className={styles.cardHeader}>
                            <div className={styles.iconWrapper} style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)', color: 'var(--primary)' }}>
                                <Database size={28} />
                            </div>
                            {config && isConfigured(config.protheus) ?
                                <span className={`${styles.status} ${styles.statusConfigured}`}>
                                    <Activity size={14} /> Configurado
                                </span> :
                                <span className={`${styles.status} ${styles.statusPending}`}>Pendente</span>
                            }
                        </div>
                        <h3 className={styles.cardTitle}>Protheus (Origem)</h3>
                        <p className={styles.cardDescription}>
                            Configure a conexão SQL Server com o banco de dados do Protheus para extração dos dados originais.
                        </p>
                        <div className={styles.cardAction} style={{ color: 'var(--primary)' }}>
                            Configurar <ArrowRight size={16} />
                        </div>
                    </motion.div>
                </Link>

                {/* Supabase Card */}
                <Link href="/settings/supabase">
                    <motion.div className={styles.card} variants={item} whileHover={{ y: -5 }}>
                        <div className={styles.cardHeader}>
                            <div className={styles.iconWrapper} style={{ backgroundColor: 'rgba(34, 211, 238, 0.1)', color: 'var(--accent)' }}>
                                <HardDrive size={28} />
                            </div>
                            {config && isConfigured(config.supabase) ?
                                <span className={`${styles.status} ${styles.statusConfigured}`}>
                                    <Activity size={14} /> Configurado
                                </span> :
                                <span className={`${styles.status} ${styles.statusPending}`}>Pendente</span>
                            }
                        </div>
                        <h3 className={styles.cardTitle}>Supabase (Intermediário)</h3>
                        <p className={styles.cardDescription}>
                            Banco de dados Postgres para transformação, limpeza e staging dos dados antes da migração final.
                        </p>
                        <div className={styles.cardAction} style={{ color: 'var(--accent)' }}>
                            Configurar <ArrowRight size={16} />
                        </div>
                    </motion.div>
                </Link>

                {/* SAP Card */}
                <Link href="/settings/sap">
                    <motion.div className={styles.card} variants={item} whileHover={{ y: -5 }}>
                        <div className={styles.cardHeader}>
                            <div className={styles.iconWrapper} style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' }}>
                                <FolderOutput size={28} />
                            </div>
                            {config && isConfigured(config.sap) ?
                                <span className={`${styles.status} ${styles.statusConfigured}`}>
                                    <Activity size={14} /> Configurado
                                </span> :
                                <span className={`${styles.status} ${styles.statusPending}`}>Pendente</span>
                            }
                        </div>
                        <h3 className={styles.cardTitle}>SAP Business One (Destino)</h3>
                        <p className={styles.cardDescription}>
                            Conexão via Service Layer para importação final dos dados, garantindo a integridade referencial.
                        </p>
                        <div className={styles.cardAction} style={{ color: '#f59e0b' }}>
                            Configurar <ArrowRight size={16} />
                        </div>
                    </motion.div>
                </Link>
            </motion.div>
        </motion.div>
    );
}
