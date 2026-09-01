import { useEffect, useRef, useState } from 'react';
import { LocationSearchController, type SearchResult } from '../core/locationSearch';

export function SearchPanel({
  focusRequest,
  recents,
  onClose,
  onGo,
  onAddPin,
  onAddRegion,
}: {
  focusRequest: number;
  recents: readonly SearchResult[];
  onClose: () => void;
  onGo: (result: SearchResult) => void;
  onAddPin: (result: SearchResult) => void;
  onAddRegion: (result: SearchResult) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [loading, setLoading] = useState(false);
  const [onlineUnavailable, setOnlineUnavailable] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef(new LocationSearchController());
  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [focusRequest]);
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void controllerRef.current.search(query).then((response) => {
        setResults(response.results);
        setOnlineUnavailable(response.onlineUnavailable);
        setHighlighted(0);
        setLoading(false);
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current.cancel();
    };
  }, [query]);
  const visible = query.trim() ? results : [...recents];
  return (
    <aside
      className="panel location-search-panel"
      aria-label="Search location"
      onWheel={(event) => event.stopPropagation()}
    >
      <header>
        <strong>Search location</strong>
        <button type="button" onClick={onClose} aria-label="Close Search">
          ×
        </button>
      </header>
      <div className="location-search-input">
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          value={query}
          placeholder="Search city, region, sea, coordinates…"
          aria-label="Search city, landmark, address, or coordinates"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onClose();
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setHighlighted((value) => Math.min(visible.length - 1, value + 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlighted((value) => Math.max(0, value - 1));
            }
            if (event.key === 'Enter' && visible[highlighted]) {
              event.preventDefault();
              onGo(visible[highlighted]);
            }
          }}
        />
        {query && (
          <button type="button" aria-label="Clear Search" onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </div>
      <div className="location-search-body">
        {!query.trim() && <small className="location-search-section">Recent</small>}
        {loading && <div className="location-search-state">Searching local geography…</div>}
        {!loading && query.trim() && visible.length === 0 && (
          <div className="location-search-state">
            No local places found for “{query}”
            {onlineUnavailable && (
              <small>Online POI/address search requires a configured production geocoder.</small>
            )}
          </div>
        )}
        <div className="location-search-results" role="listbox">
          {visible.map((result, index) => (
            <article
              key={result.id}
              className={index === highlighted ? 'highlighted' : ''}
              role="option"
              aria-selected={index === highlighted}
              onMouseEnter={() => setHighlighted(index)}
            >
              <div className="location-result-main">
                <strong>
                  {result.localizedName && /[\u0600-\u06ff]/.test(query) ? result.localizedName : result.name}
                </strong>
                <span>
                  {result.category}
                  {result.secondaryText ? ` · ${result.secondaryText}` : ''}
                </span>
              </div>
              <div className="location-result-actions">
                <button type="button" onClick={() => onGo(result)}>
                  Go Here
                </button>
                <button type="button" onClick={() => onAddPin(result)}>
                  Add Pin
                </button>
                {result.capabilities.addRegion && (
                  <button type="button" onClick={() => onAddRegion(result)}>
                    Add Region
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
      <footer>
        Local geography and coordinates
        <span>Online POI/address search not configured</span>
      </footer>
    </aside>
  );
}
