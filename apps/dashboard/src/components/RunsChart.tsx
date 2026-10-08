// Runs per day, last 14 days: stacked columns (succeeded below, failed on top).
// Colors are the validated --af-chart-ok / --af-chart-fail tokens (CVD-safe in both
// themes); identity is also carried by the legend, tooltip and the table view.
import { Segmented } from '@autoflow/ui';
import { useMemo, useState } from 'react';

interface Day {
  day: string;
  succeeded: number;
  failed: number;
}

const BAR_MAX = 24;
const H = 160;

export function RunsChart({ daily }: { daily: Day[] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<number | null>(null);
  const days = useMemo(() => fillDays(daily, 14), [daily]);
  const max = Math.max(1, ...days.map((d) => d.succeeded + d.failed));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]!;
  const total = days.reduce((n, d) => n + d.succeeded + d.failed, 0);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <Legend />
        <span className="flex-1" />
        <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
      </div>
      {view === 'table' ? (
        <table className="w-full text-[13px]">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-medium">Day</th>
              <th className="py-1 text-right font-medium">Succeeded</th>
              <th className="py-1 text-right font-medium">Failed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border tabular-nums">
            {days.map((d) => (
              <tr key={d.day}>
                <td className="py-1">{label(d.day, true)}</td>
                <td className="py-1 text-right">{d.succeeded}</td>
                <td className="py-1 text-right">{d.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : total === 0 ? (
        <p className="py-12 text-center text-[13px] text-subtle">No finished runs in the last 14 days.</p>
      ) : (
        <div className="relative" role="img" aria-label={`Runs per day for the last 14 days: ${total} ${total === 1 ? 'run' : 'runs'}`}>
          <div className="flex">
            {/* y axis */}
            <div className="relative mr-2 w-6 shrink-0 text-right text-[11px] text-subtle tabular-nums" style={{ height: H }}>
              {ticks.map((t) => (
                <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: H - (t / top) * H }}>
                  {t}
                </span>
              ))}
            </div>
            <div className="relative flex-1" style={{ height: H }}>
              {ticks.map((t) => (
                <div key={t} className="absolute right-0 left-0 border-t border-border/70" style={{ top: H - (t / top) * H }} />
              ))}
              <div className="absolute inset-0 flex items-end">
                {days.map((d, i) => {
                  const okH = (d.succeeded / top) * H;
                  const failH = (d.failed / top) * H;
                  return (
                    <div
                      key={d.day}
                      className="flex h-full flex-1 flex-col items-center justify-end"
                      onMouseEnter={() => setHover(i)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <div className="flex flex-col items-stretch" style={{ width: `min(${BAR_MAX}px, 70%)` }}>
                        {d.failed > 0 && (
                          <div
                            className="bg-chart-fail"
                            style={{ height: failH, borderRadius: '4px 4px 0 0', marginBottom: d.succeeded > 0 ? 2 : 0 }}
                          />
                        )}
                        {d.succeeded > 0 && (
                          <div className="bg-chart-ok" style={{ height: okH, borderRadius: d.failed > 0 ? 0 : '4px 4px 0 0' }} />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {hover !== null && <Tip day={days[hover]!} index={hover} count={days.length} />}
            </div>
          </div>
          <div className="ml-8 flex text-[11px] text-subtle">
            {days.map((d, i) => (
              <span key={d.day} className="flex-1 text-center">
                {i % 2 === 0 || days.length <= 7 ? label(d.day) : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-[13px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-chart-ok" /> Succeeded
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-sm bg-chart-fail" /> Failed
      </span>
    </div>
  );
}

function Tip({ day, index, count }: { day: Day; index: number; count: number }) {
  const left = ((index + 0.5) / count) * 100;
  return (
    <div
      className="pointer-events-none absolute -top-2 z-10 w-36 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface p-2 text-xs shadow-pop"
      style={{ left: `${left}%` }}
      role="tooltip"
    >
      <p className="mb-1 font-semibold">{label(day.day, true)}</p>
      <p className="flex items-center gap-1.5 text-muted">
        <span className="h-2 w-2 rounded-sm bg-chart-ok" /> Succeeded <span className="ml-auto font-medium text-fg tabular-nums">{day.succeeded}</span>
      </p>
      <p className="flex items-center gap-1.5 text-muted">
        <span className="h-2 w-2 rounded-sm bg-chart-fail" /> Failed <span className="ml-auto font-medium text-fg tabular-nums">{day.failed}</span>
      </p>
    </div>
  );
}

function fillDays(daily: Day[], n: number): Day[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: Day[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const found = byDay.get(key);
    out.push({ day: key, succeeded: found?.succeeded ?? 0, failed: found?.failed ?? 0 });
  }
  return out;
}

function niceTicks(max: number): number[] {
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const ticks = [];
  for (let t = 0; t <= max + step - 1 && ticks.length < 7; t += step) ticks.push(t);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

function label(day: string, long = false): string {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString(undefined, long ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' });
}
