'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Database, Layers, Settings, Home, Play, Users, ArrowLeftRight, BookOpen, RadioTower, Trash2 } from 'lucide-react';
import styles from './Layout.module.css';

const navItems = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Configurações', href: '/settings', icon: Settings },
  { name: 'Seleção de Tabelas', href: '/settings/tables', icon: Layers },
  { name: 'Mapeamento (De/Para)', href: '/settings/mapping', icon: ArrowLeftRight },
  { name: 'Naturezas (SED010)', href: '/settings/naturezas', icon: BookOpen },
  { name: 'Dados Replicados', href: '/data', icon: Database },
  { name: 'SAP: Parceiros', href: '/sap/business-partners', icon: Users },
  { name: 'SAP: Cancelar/Excluir', href: '/sap/delete', icon: Trash2 },
  { name: 'Migração', href: '/run', icon: Play },
  { name: 'Control Tower 🔒', href: '/control-tower', icon: RadioTower },
];


export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <span>Migração</span>
        <span className={styles.accent}>ERP</span>
      </div>
      <nav className={styles.nav}>
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navItem} ${isActive ? styles.active : ''}`}
            >
              <item.icon className={styles.icon} size={20} />
              <span>{item.name}</span>
            </Link>
          );
        })}
      </nav>
      <div className={styles.footer}>
        <Settings className={styles.icon} size={20} />
        <span>Configurações</span>
      </div>
    </aside>
  );
}
