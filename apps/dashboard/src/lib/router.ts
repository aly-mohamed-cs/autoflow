// Tiny hash router: #/automations/flow_x -> { path: ['automations', 'flow_x'] }
import { useEffect, useState } from 'react';

export function currentPath(): string[] {
  return window.location.hash.replace(/^#\/?/, '').split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

export function href(...parts: string[]): string {
  return `#/${parts.map(encodeURIComponent).join('/')}`;
}

export function go(...parts: string[]): void {
  window.location.hash = href(...parts).slice(1);
}
