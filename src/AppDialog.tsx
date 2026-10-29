import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import './settings.css';

export function AppDialog({
  title,
  onClose,
  busy = false,
  wide = false,
  children
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`app-dialog ${wide ? 'wide' : ''}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="app-dialog-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="settings-icon"
          aria-label={`关闭${title}`}
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
