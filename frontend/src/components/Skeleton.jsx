/**
 * Skeleton loading blocks — rendered while a screen fetches its data.
 * Sized to match the real layout so the UI doesn't jump on load.
 */

export function HomeSkeleton() {
  return (
    <div className="screen" aria-busy="true">
      <div className="skeleton">
        <div className="sk sk-hero" />
        <div className="sk sk-btn" />
      </div>
      <div className="skeleton">
        <div className="sk sk-title" />
        <div className="sk-grid">
          <div className="sk" />
          <div className="sk" />
          <div className="sk" />
          <div className="sk" />
        </div>
      </div>
      <div className="skeleton">
        <div className="sk sk-title" />
        <div className="sk sk-row" />
        <div className="sk sk-row" />
      </div>
    </div>
  );
}

export function ActivitySkeleton() {
  return (
    <div className="screen" aria-busy="true">
      <div className="skeleton">
        <div className="sk" style={{ height: 42, borderRadius: 999 }} />
        <div className="sk sk-row" />
        <div className="sk sk-row" />
        <div className="sk sk-row" />
      </div>
    </div>
  );
}

export function AccountSkeleton() {
  return (
    <div className="screen" aria-busy="true">
      <div className="skeleton">
        <div className="sk sk-title" />
        <div className="sk sk-row" />
        <div className="sk sk-row" />
      </div>
      <div className="skeleton">
        <div className="sk sk-title" />
        <div className="sk sk-row" />
      </div>
    </div>
  );
}

export function MapSkeleton() {
  return (
    <div className="screen" aria-busy="true">
      <div className="skeleton map-skeleton">
        <div className="sk sk-map-status" />
        <div className="sk sk-map-dot" />
        <div className="sk sk-map-controls" />
      </div>
      <div className="sk sk-btn" />
      <div className="skeleton">
        <div className="sk sk-title" />
        <div className="sk sk-row" />
        <div className="sk sk-row" />
      </div>
    </div>
  );
}
