import { Button, cn, Icon } from '@autoflow/ui';
import { useState } from 'react';
import { useApi } from '../lib/api';

interface Notice {
  id: string;
  message: string;
  tone: 'info' | 'warning';
}

const KEY = 'autoflow.hiddenNotices';

function hidden(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Notices from administrators, at the top of every page (hidden for this visit once closed). */
export function NoticeBanner() {
  const { data } = useApi<{ notices: Notice[] }>('/api/notices');
  const [closed, setClosed] = useState<string[]>(hidden);
  const notices = (data?.notices ?? []).filter((n) => !closed.includes(n.id));
  if (!notices.length) return null;
  const close = (id: string) => {
    const next = [...closed, id];
    setClosed(next);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* private window: hidden until reload */
    }
  };
  return (
    <div className="space-y-2 px-4 pt-4 sm:px-8" role="region" aria-label="Notices">
      {notices.map((n) => (
        <div
          key={n.id}
          className={cn(
            'mx-auto flex max-w-7xl items-start gap-3 rounded-lg border px-4 py-2.5 text-[13px]',
            n.tone === 'warning' ? 'border-transparent bg-warning-soft text-warning' : 'border-border bg-primary-soft text-fg',
          )}
        >
          <Icon name={n.tone === 'warning' ? 'triangle-alert' : 'megaphone'} size={16} className="mt-0.5 shrink-0" />
          <p className="flex-1 whitespace-pre-line">{n.message}</p>
          <Button variant="ghost" size="icon" aria-label="Hide this notice" onClick={() => close(n.id)}>
            <Icon name="x" size={14} />
          </Button>
        </div>
      ))}
    </div>
  );
}
