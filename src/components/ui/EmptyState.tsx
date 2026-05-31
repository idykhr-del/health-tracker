interface Props {
  icon: string
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}

export default function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
      <span className="text-5xl">{icon}</span>
      <p className="text-foreground font-semibold text-base">{title}</p>
      <p className="text-muted text-sm leading-relaxed">{description}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-2 px-5 py-2 rounded-full bg-accent text-bg text-sm font-semibold"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
