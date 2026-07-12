'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { erpRequest } from '@/lib/client-api';

interface SearchItem {
  sourceType: string; sourceId: string; title: string; summary: string;
  classification: string; actionPath: string;
}

export function GlobalSearch(): React.ReactNode {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const search = useQuery({ queryKey: ['global-search', query], enabled: query.trim().length >= 2,
    queryFn: () => erpRequest<{ items: SearchItem[] }>(
      `v1/search?q=${encodeURIComponent(query.trim())}&limit=12`,
    ), staleTime: 10_000 });
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
      }
      if (event.key === 'Escape' && document.activeElement === input.current) {
        setQuery('');
        input.current?.blur();
      }
    };
    window.addEventListener('keydown', handler);
    return (): void => window.removeEventListener('keydown', handler);
  }, []);
  const active = query.trim().length >= 2;
  const items = search.data?.items ?? [];
  return <div className="global-search">
    <label className="visually-hidden" htmlFor="global-search-input">Search NIET records</label>
    <input ref={input} id="global-search-input" type="search" value={query}
      onChange={(event) => setQuery(event.target.value)} placeholder="Search NIET records"
      />
    <span className="search-shortcut" aria-hidden="true">Ctrl K</span>
    {active && <div className="search-results" role="region" aria-label="Search results">
      {search.isLoading ? <p role="status">Searching authorized records…</p>
        : search.isError ? <p className="field-error" role="alert">Search is unavailable or not included in your access.</p>
          : items.length === 0 ? <p>No authorized results.</p>
            : <ul>{items.map((item) => <li key={`${item.sourceType}:${item.sourceId}`}>
              <a href={item.actionPath}><strong>{item.title}</strong><span>{item.summary}</span>
                <small>{item.sourceType} · {item.classification.toLowerCase()}</small></a>
            </li>)}</ul>}
    </div>}
  </div>;
}
