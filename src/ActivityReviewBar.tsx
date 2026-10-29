import { Check, Loader2, RotateCcw } from 'lucide-react';

export function ActivityReviewBar({
  count,
  busy,
  onApply,
  onCancel,
  onMap = false
}: {
  count: number;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
  onMap?: boolean;
}) {
  if (!count) return null;
  return (
    <div
      className={`activity-review-bar ${onMap ? 'on-map' : 'in-panel'}`}
      role="region"
      aria-label="待更新的路线修改"
    >
      <div>
        <strong>已修改 {count} 处</strong>
        <small>选完后统一更新路线</small>
      </div>
      <div className="activity-review-actions">
        <button
          type="button"
          className="activity-review-cancel"
          disabled={busy}
          onClick={onCancel}
        >
          <RotateCcw size={12} />
          撤销
        </button>
        <button
          type="button"
          className="activity-review-apply"
          disabled={busy}
          onClick={onApply}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
          更新路线
        </button>
      </div>
    </div>
  );
}
