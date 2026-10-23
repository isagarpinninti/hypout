import { useMemo, type ReactNode } from "react";
import { usePolled, type AdminConnection } from "./admin";
import type { ChannelStat, ChannelsResponse } from "./types";

export interface ChannelTopologyStudioProps extends AdminConnection {
  pollMs?: number;
  onSelectChannel?(name: string): void;
  className?: string;
}

const nsOf = (name: string): string => name.split(":", 1)[0] as string;
const W = 640;
const ROW = 34;

/**
 * The shape of the server: every namespace you defined, and the live channels under it with their subscribers,
 * head sequence and presence. The drawing is decorative; the table beside it carries the same facts for screen readers.
 */
export function ChannelTopologyStudio({ baseUrl, token, pollMs = 2000, onSelectChannel, className }: ChannelTopologyStudioProps): ReactNode {
  const { data, error } = usePolled<ChannelsResponse>({ baseUrl, token }, "/api/channels", pollMs);

  const groups = useMemo(() => {
    const by = new Map<string, ChannelStat[]>();
    for (const d of data?.namespaces ?? []) by.set(d.namespace, []);
    for (const c of data?.channels ?? []) {
      const list = by.get(nsOf(c.name)) ?? [];
      list.push(c);
      by.set(nsOf(c.name), list);
    }
    return [...by].map(([ns, channels]) => ({ ns, channels: [...channels].sort((a, b) => b.subscribers - a.subscribers).slice(0, 6), total: channels.length }));
  }, [data]);

  const rows = Math.max(1, groups.reduce((n, g) => n + Math.max(1, g.channels.length), 0));
  const H = Math.max(120, rows * ROW + 24);
  let y = 12;
  const layout = groups.map((g) => {
    const top = y;
    const items = g.channels.map((c, i) => ({ c, y: top + i * ROW + ROW / 2 }));
    y += Math.max(1, g.channels.length) * ROW;
    return { ...g, items, cy: top + (Math.max(1, g.channels.length) * ROW) / 2 };
  });
  const maxSubs = Math.max(1, ...(data?.channels ?? []).map((c) => c.subscribers));

  return (
    <section className={`hy-card hy-topology${className ? ` ${className}` : ""}`} aria-label="Channel topology">
      <header className="hy-card-head">
        <h3 className="hy-h">Channel topology</h3>
        <span className="hy-muted">{data ? `${data.namespaces.length} namespaces · ${data.channels.length} live channels` : "Loading…"}</span>
      </header>
      {error ? (
        <p className="hy-error" role="alert">
          Cannot read the server: {error}
        </p>
      ) : null}
      <div className="hy-topology-grid">
        <svg className="hy-graph" viewBox={`0 0 ${W} ${H}`} role="presentation" aria-hidden="true" preserveAspectRatio="xMinYMin meet">
          <circle cx={36} cy={H / 2} r={9} className="hy-node-live" />
          <text x={36} y={H / 2 + 28} textAnchor="middle" className="hy-svg-label">
            server
          </text>
          {layout.map((g) => (
            <g key={g.ns}>
              <path d={`M45 ${H / 2} C 120 ${H / 2}, 120 ${g.cy}, 200 ${g.cy}`} className="hy-edge" />
              <rect x={200} y={g.cy - 13} width={118} height={26} rx={7} className="hy-node" />
              <text x={259} y={g.cy + 4} textAnchor="middle" className="hy-svg-text">
                {g.ns}
              </text>
              {g.items.map(({ c, y: cy }) => (
                <g key={c.name}>
                  <path d={`M318 ${g.cy} C 360 ${g.cy}, 360 ${cy}, 400 ${cy}`} className="hy-edge" strokeWidth={1 + (3 * c.subscribers) / maxSubs} />
                  <rect x={400} y={cy - 12} width={220} height={24} rx={6} className="hy-node hy-node-sm" />
                  <text x={410} y={cy + 4} className="hy-svg-text hy-svg-mono">
                    {c.name.length > 20 ? `${c.name.slice(0, 19)}…` : c.name}
                  </text>
                  <text x={610} y={cy + 4} textAnchor="end" className="hy-svg-label">
                    {c.subscribers} sub
                  </text>
                </g>
              ))}
            </g>
          ))}
        </svg>
        <table className="hy-table">
          <caption className="hy-sr">Namespaces and their live channels</caption>
          <thead>
            <tr>
              <th scope="col">Namespace</th>
              <th scope="col">Access</th>
              <th scope="col">Events</th>
              <th scope="col">Live</th>
            </tr>
          </thead>
          <tbody>
            {(data?.namespaces ?? []).map((d) => {
              const g = groups.find((x) => x.ns === d.namespace);
              return (
                <tr key={d.namespace}>
                  <th scope="row">{d.namespace}</th>
                  <td>
                    <span className="hy-badge">sub {d.access.subscribe}</span> <span className="hy-badge">pub {d.access.publish}</span>
                    {d.access.presence !== "off" ? <span className="hy-badge"> presence {d.access.presence}</span> : null}
                  </td>
                  <td>{Object.keys(d.events).length || "any"}</td>
                  <td>
                    {g?.total ? (
                      <ul className="hy-inline-list">
                        {g.channels.map((c) => (
                          <li key={c.name}>
                            {onSelectChannel ? (
                              <button type="button" className="hy-link" onClick={() => onSelectChannel(c.name)}>
                                {c.name}
                              </button>
                            ) : (
                              <code>{c.name}</code>
                            )}{" "}
                            <span className="hy-muted">
                              {c.subscribers} sub · #{c.head} · {c.members} here
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="hy-muted">none</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
