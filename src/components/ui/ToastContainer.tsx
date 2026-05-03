import type { Toast } from '../../hooks/useToast'

interface Props {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

export default function ToastContainer({ toasts, onDismiss }: Props) {
  if (!toasts.length) return null

  return (
    <div className="fixed top-4 left-0 right-0 z-50 flex flex-col items-center gap-2 px-4 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`pointer-events-auto max-w-sm w-full rounded-lg px-4 py-3 text-sm font-medium shadow-lg cursor-pointer
            ${t.type === 'success' ? 'bg-accentGreen text-bg'
            : t.type === 'error'   ? 'bg-red-500 text-white'
            :                        'bg-accent text-bg'}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
