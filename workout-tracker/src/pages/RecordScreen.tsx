import { useState, useEffect, useMemo } from 'react'
import type { Category, WorkoutSession, ExerciseEntry, WorkoutSet, SessionNote } from '../types'
import {
  CATEGORIES,
  CATEGORY_ICONS,
  DEFAULT_EXERCISES,
} from '../data/exercises'
import type { CustomExercise } from '../types'
import {
  loadDraftSync,
  loadDraftAsync,
  saveDraft,
  clearDraft,
  mergeDraft,
  loadUsageSync,
  incrementUsage,
  type UsageMap,
} from '../utils/storage'
import { calcStrengthSetCalories, calcCardioSetCalories } from '../utils/calorieCalc'

interface Props {
  onSaveSession: (session: WorkoutSession) => void
  customExercises: CustomExercise[]
  onAddCustomExercise: (ex: CustomExercise) => void
  sessions: WorkoutSession[]
  bodyWeight: number
  restSeconds: number
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

const LAT_PULLDOWN_GRIPS = [
  'ベントバー',
  'ミドルパラレルグリップ',
  'ミドルオーバーグリップ',
  'ミドルアンダーグリップ',
  'ナローパラレルグリップ',
  'ナローオーバーグリップ',
  'ナローアンダーグリップ',
  'ワイドグリップ',
] as const

interface PRItem { name: string; prevAvg: number; newAvg: number }

// ── Helpers ─────────────────────────────────────────────────────────

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nowTimeStr(): string {
  return new Date().toTimeString().slice(0, 5)
}

function newSession(): WorkoutSession {
  return { id: crypto.randomUUID(), date: todayStr(), startTime: '', exercises: [], notes: [] }
}

function getLastSetTimestamp(session: WorkoutSession): string | null {
  let last: string | null = null
  for (const ex of session.exercises)
    for (const set of ex.sets)
      if (!last || set.timestamp > last) last = set.timestamp
  return last
}

function getExerciseEntryLabel(exercises: ExerciseEntry[], entry: ExerciseEntry): string {
  const same = exercises.filter(e => e.name === entry.name)
  const idx  = same.findIndex(e => e.instanceId === entry.instanceId)
  return idx <= 0 ? entry.name : `${entry.name}（${idx + 1}回目）`
}

function sortByUsage(names: string[], category: string, usage: UsageMap): string[] {
  return [...names].sort((a, b) => (usage[`${category}/${b}`] ?? 0) - (usage[`${category}/${a}`] ?? 0))
}

/** Returns all sets from the most recent session (≠ current) that logged this exercise. */
function getPreviousSets(
  sessions: WorkoutSession[],
  currentId: string,
  category: string,
  name: string,
): WorkoutSet[] | null {
  const sorted = [...sessions]
    .filter(s => s.id !== currentId)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.startTime ?? '').localeCompare(a.startTime ?? ''))
  for (const s of sorted) {
    const allSets = s.exercises
      .filter(e => e.category === category && e.name === name)
      .flatMap(e => e.sets)
    if (allSets.length > 0) return allSets
  }
  return null
}

/** Computes which exercises set a new PR (avg load = sum(w×r) / sets). */
function computePRs(session: WorkoutSession, allSessions: WorkoutSession[]): PRItem[] {
  const history = allSessions.filter(s => s.id !== session.id)
  const prs: PRItem[] = []
  for (const ex of session.exercises) {
    if (ex.category === '有酸素') continue
    const curSets = ex.sets.filter(s => (s.weight ?? 0) > 0 && (s.reps ?? 0) > 0)
    if (curSets.length === 0) continue
    const curAvg = curSets.reduce((sum, s) => sum + s.weight! * s.reps!, 0) / curSets.length
    let bestHist = 0
    for (const hs of history) {
      for (const e of hs.exercises.filter(e => e.category === ex.category && e.name === ex.name)) {
        const valid = e.sets.filter(s => (s.weight ?? 0) > 0 && (s.reps ?? 0) > 0)
        if (!valid.length) continue
        const avg = valid.reduce((sum, s) => sum + s.weight! * s.reps!, 0) / valid.length
        if (avg > bestHist) bestHist = avg
      }
    }
    if (bestHist > 0 && curAvg > bestHist)
      prs.push({ name: ex.name, prevAvg: Math.round(bestHist), newAvg: Math.round(curAvg) })
  }
  return prs
}

function formatElapsed(sec: number): string {
  if (sec < 0) sec = 0
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

// ── Component ────────────────────────────────────────────────────────

export default function RecordScreen({
  onSaveSession, customExercises, onAddCustomExercise, sessions, bodyWeight, restSeconds,
}: Props) {
  // ── Core session state ────────────────────────────────────────────
  const [session, setSession] = useState<WorkoutSession>(() => loadDraftSync() ?? newSession())
  const [usage,   setUsage]   = useState<UsageMap>(() => loadUsageSync())

  // ── Workout active state ──────────────────────────────────────────
  // Workout is "started" if the session already has a startTime (persisted in draft)
  const [isWorkoutStarted, setIsWorkoutStarted] = useState<boolean>(() => {
    const d = loadDraftSync()
    return d != null && d.startTime !== ''
  })
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  // ── Navigation state ──────────────────────────────────────────────
  const [selectedCategory, setSelectedCategory] = useState<Category>('胸')
  const [selectedExercise, setSelectedExercise] = useState<string>(() => DEFAULT_EXERCISES['胸'][0])
  const [currentInstanceId, setCurrentInstanceId] = useState(() => crypto.randomUUID())
  const [isMemoMode, setIsMemoMode] = useState(false)

  // ── Input state ───────────────────────────────────────────────────
  const [weightInput,   setWeightInput]   = useState('')
  const [repsInput,     setRepsInput]     = useState('')
  const [durationInput, setDurationInput] = useState('')
  const [distanceInput, setDistanceInput] = useState('')
  const [inclineInput,  setInclineInput]  = useState('')
  const [gripInput,     setGripInput]     = useState('')
  const [setMemoInput,  setSetMemoInput]  = useState('')

  // ── Datetime ──────────────────────────────────────────────────────
  const [showDatePicker,    setShowDatePicker]    = useState(false)
  const [customDate,        setCustomDate]        = useState(todayStr())
  const [customTime,        setCustomTime]        = useState(nowTimeStr())
  const [useCustomDateTime, setUseCustomDateTime] = useState(false)

  // ── Notes ─────────────────────────────────────────────────────────
  const [noteScore, setNoteScore] = useState(5)
  const [noteText,  setNoteText]  = useState('')

  // ── Modals / overlays ─────────────────────────────────────────────
  const [editingSetId,      setEditingSetId]      = useState<string | null>(null)
  const [showFinishModal,   setShowFinishModal]   = useState(false)
  const [rating,            setRating]            = useState(7)
  const [finishMemo,        setFinishMemo]        = useState('')
  const [showCustomModal,   setShowCustomModal]   = useState(false)
  const [customName,        setCustomName]        = useState('')
  const [customModalCat,    setCustomModalCat]    = useState<Category>(selectedCategory)
  const [customModalType,   setCustomModalType]   = useState<'strength' | 'cardio'>('strength')
  const [showSuccess,       setShowSuccess]       = useState(false)
  const [showPRCelebration, setShowPRCelebration] = useState(false)
  const [prs,               setPrs]              = useState<PRItem[]>([])
  const [finishedSetCount,  setFinishedSetCount]  = useState(0)
  const [deleteConfirmId,   setDeleteConfirmId]   = useState<string | null>(null)
  const [toast,             setToast]             = useState('')
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // ── Derived ───────────────────────────────────────────────────────
  /** カスタム有酸素種目（非有酸素カテゴリに登録されたカーディオタイプ）か */
  const isCustomCardio = useMemo(() => {
    if (selectedCategory === '有酸素') return false
    return customExercises.some(
      c => c.category === selectedCategory && c.name === selectedExercise && c.exerciseType === 'cardio'
    )
  }, [selectedCategory, selectedExercise, customExercises])

  const isCardio      = selectedCategory === '有酸素' || isCustomCardio
  const isWalking     = selectedExercise === 'ウォーキング'
  const isLatPulldown = selectedExercise === 'ラットプルダウン'

  const estimatedCalories = useMemo(() => {
    if (isCardio) {
      if (!durationInput) return null
      const mins = parseFloat(durationInput)
      if (isNaN(mins) || mins <= 0) return null
      const dist = distanceInput ? parseFloat(distanceInput) : undefined
      const inc  = isWalking ? parseFloat(inclineInput || '0') : undefined
      return calcCardioSetCalories(selectedExercise, mins, dist, inc, bodyWeight)
    } else {
      if (!repsInput) return null
      const reps = parseInt(repsInput)
      if (isNaN(reps) || reps <= 0) return null
      return calcStrengthSetCalories(selectedExercise, selectedCategory, reps, restSeconds, bodyWeight)
    }
  }, [isCardio, isWalking, selectedExercise, selectedCategory, durationInput, distanceInput, inclineInput, repsInput, bodyWeight, restSeconds])

  /** セッション全体のカロリー内訳（フィニッシュモーダル用） */
  const sessionCalSummary = useMemo(() => {
    let strength = 0, cardio = 0
    for (const ex of session.exercises) {
      for (const set of ex.sets) {
        const cal = set.calories ?? 0
        if (ex.category === '有酸素') cardio += cal
        else strength += cal
      }
    }
    return { strength, cardio, total: strength + cardio }
  }, [session.exercises])

  const allExercisesSorted = useMemo(() => {
    const base = [
      ...DEFAULT_EXERCISES[selectedCategory],
      ...customExercises.filter(c => c.category === selectedCategory).map(c => c.name),
    ]
    return sortByUsage(base, selectedCategory, usage)
  }, [selectedCategory, customExercises, usage])

  const allExercisesForCat = (cat: Category) => [
    ...DEFAULT_EXERCISES[cat],
    ...customExercises.filter(c => c.category === cat).map(c => c.name),
  ]

  const previousSets = useMemo(
    () => getPreviousSets(sessions, session.id, selectedCategory, selectedExercise),
    [sessions, session.id, selectedCategory, selectedExercise],
  )

  const currentExerciseEntry = (): ExerciseEntry | undefined =>
    session.exercises.find(
      e => e.category === selectedCategory && e.name === selectedExercise && e.instanceId === currentInstanceId,
    )

  const currentSets = currentExerciseEntry()?.sets ?? []

  /** 現在選択中の種目の今日の合計カロリー */
  const currentExerciseCalories = currentSets.reduce((sum, s) => sum + (s.calories ?? 0), 0)

  const currentExerciseLabel = useMemo(() => {
    const same = session.exercises.filter(e => e.name === selectedExercise)
    const idx  = same.findIndex(e => e.instanceId === currentInstanceId)
    const ord  = idx >= 0 ? idx + 1 : same.length + 1
    return ord > 1 ? `${selectedExercise}（${ord}回目）` : selectedExercise
  }, [session.exercises, selectedExercise, currentInstanceId])

  const totalSets = session.exercises.reduce((acc, e) => acc + e.sets.length, 0)

  // ── Elapsed time timer ────────────────────────────────────────────
  useEffect(() => {
    if (!isWorkoutStarted || !session.startTime || !session.date) return
    const calc = () => {
      const start = new Date(`${session.date}T${session.startTime}:00`)
      return Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000))
    }
    setElapsedSeconds(calc())
    const id = setInterval(() => setElapsedSeconds(calc()), 1000)
    return () => clearInterval(id)
  }, [isWorkoutStarted, session.startTime, session.date])

  // ── IDB hydration ────────────────────────────────────────────────
  useEffect(() => {
    loadDraftAsync().then(idbDraft => {
      if (!idbDraft) return
      setSession(prev => {
        const merged = mergeDraft(prev, idbDraft)
        if (!merged || merged === prev) return prev
        // Restore started state if the merged draft has a startTime
        if (merged.startTime) setIsWorkoutStarted(true)
        return merged
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Persistence ───────────────────────────────────────────────────
  const updateSession = (next: WorkoutSession) => { saveDraft(next); setSession(next) }

  useEffect(() => { saveDraft(session) }, [session])

  // ── Utilities ─────────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg); setTimeout(() => setToast(''), 4000)
  }

  const clearSetInputs = () => {
    setWeightInput(''); setRepsInput(''); setDurationInput('')
    setDistanceInput(''); setInclineInput(''); setGripInput('')
    setSetMemoInput(''); setEditingSetId(null)
  }

  function resolveTimestamp(): string {
    if (useCustomDateTime && customDate && customTime)
      return new Date(`${customDate}T${customTime}:00`).toISOString()
    return new Date().toISOString()
  }

  function buildNewSet(existingId?: string): WorkoutSet {
    let cal: number | undefined
    let inc: number | undefined

    if (isCardio && durationInput) {
      const mins = parseFloat(durationInput)
      if (!isNaN(mins) && mins > 0) {
        const dist = distanceInput ? parseFloat(distanceInput) : undefined
        if (isWalking) {
          const rawInc = parseFloat(inclineInput || '0')
          inc = isNaN(rawInc) ? 0 : rawInc
        }
        cal = calcCardioSetCalories(selectedExercise, mins, dist, inc, bodyWeight)
      }
    } else if (!isCardio && weightInput && repsInput) {
      const reps = parseInt(repsInput, 10)
      if (!isNaN(reps) && reps > 0) {
        cal = calcStrengthSetCalories(selectedExercise, selectedCategory, reps, restSeconds, bodyWeight)
      }
    }

    return {
      id: existingId ?? crypto.randomUUID(),
      timestamp: existingId ? new Date().toISOString() : resolveTimestamp(),
      ...(isCardio
        ? {
            durationMinutes: parseFloat(durationInput),
            distanceKm: distanceInput ? parseFloat(distanceInput) : undefined,
            incline: inc,
            calories: cal,
          }
        : {
            weight: parseFloat(weightInput),
            reps: parseInt(repsInput, 10),
            calories: cal,
          }),
      grip: (!isCardio && isLatPulldown && gripInput) ? gripInput : undefined,
      memo: setMemoInput.trim() || undefined,
    }
  }

  // ── Workout start ─────────────────────────────────────────────────
  const startWorkout = () => {
    const now    = new Date()
    const date   = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const time   = now.toTimeString().slice(0, 5)
    updateSession({ ...session, date, startTime: time })
    setIsWorkoutStarted(true)
  }

  // ── Navigation ────────────────────────────────────────────────────
  const handleCategoryClick = (cat: Category) => {
    setSelectedCategory(cat); setIsMemoMode(false)
    setSelectedExercise(allExercisesForCat(cat)[0] ?? '')
    setCurrentInstanceId(crypto.randomUUID()); clearSetInputs()
  }

  const handleExerciseChange = (name: string) => {
    setSelectedExercise(name); setCurrentInstanceId(crypto.randomUUID()); clearSetInputs()
  }

  // ── Set CRUD ──────────────────────────────────────────────────────
  const startEditSet = (set: WorkoutSet) => {
    setEditingSetId(set.id); setSetMemoInput(set.memo ?? '')
    if (isCardio) {
      setDurationInput(String(set.durationMinutes ?? ''))
      setDistanceInput(String(set.distanceKm ?? ''))
      if (isWalking) setInclineInput(String(set.incline ?? ''))
    } else {
      setWeightInput(String(set.weight ?? ''))
      setRepsInput(String(set.reps ?? ''))
      if (isLatPulldown) setGripInput(set.grip ?? '')
    }
  }

  const deleteSet = (setId: string) => {
    const updated = session.exercises
      .map(e => {
        if (e.category === selectedCategory && e.name === selectedExercise && e.instanceId === currentInstanceId)
          return { ...e, sets: e.sets.filter(s => s.id !== setId) }
        return e
      })
      .filter(e => e.sets.length > 0)
    updateSession({ ...session, exercises: updated })
    setDeleteConfirmId(null)
    if (editingSetId === setId) clearSetInputs()
  }

  const addOrUpdateSet = () => {
    if (!isWorkoutStarted) return
    if (isCardio ? !durationInput : !weightInput || !repsInput) return

    // ── 5-hour auto-split ────────────────────────────────────────
    if (!editingSetId) {
      const lastTs = getLastSetTimestamp(session)
      if (lastTs && Date.now() - new Date(lastTs).getTime() >= FIVE_HOURS_MS) {
        onSaveSession({ ...session, endTime: new Date().toTimeString().slice(0, 5) })
        clearDraft()
        const splitSet = buildNewSet()
        const newInstId = crypto.randomUUID()
        setCurrentInstanceId(newInstId)
        const splitNow = new Date()
        updateSession({
          ...newSession(),
          date: `${splitNow.getFullYear()}-${String(splitNow.getMonth() + 1).padStart(2, '0')}-${String(splitNow.getDate()).padStart(2, '0')}`,
          startTime: splitNow.toTimeString().slice(0, 5),
          exercises: [{ category: selectedCategory, name: selectedExercise, instanceId: newInstId, sets: [splitSet] }],
        })
        clearSetInputs()
        showToast('前回のトレーニングから5時間以上経過したため、新しいセッションを開始しました')
        return
      }
    }

    // ── Normal add / update ──────────────────────────────────────
    const newSet = buildNewSet(editingSetId ?? undefined)
    const ex     = currentExerciseEntry()
    let updatedExercises: ExerciseEntry[]
    if (ex) {
      updatedExercises = session.exercises.map(e => {
        if (e.category === selectedCategory && e.name === selectedExercise && e.instanceId === currentInstanceId) {
          const sets = editingSetId
            ? e.sets.map(s => s.id === editingSetId ? newSet : s)
            : [...e.sets, newSet]
          return { ...e, sets }
        }
        return e
      })
    } else {
      updatedExercises = [
        ...session.exercises,
        { category: selectedCategory, name: selectedExercise, instanceId: currentInstanceId, sets: [newSet] },
      ]
    }
    updateSession({ ...session, exercises: updatedExercises })

    if (!editingSetId) {
      const alreadyIn = session.exercises.some(
        e => e.category === selectedCategory && e.name === selectedExercise,
      )
      if (!alreadyIn) setUsage(incrementUsage(selectedCategory, selectedExercise))
    }
    clearSetInputs()
  }

  // ── Notes ─────────────────────────────────────────────────────────
  const addNote = () => {
    if (!noteText.trim()) return
    const note: SessionNote = { score: noteScore, text: noteText.trim(), timestamp: new Date().toISOString() }
    updateSession({ ...session, notes: [...(session.notes ?? []), note] })
    setNoteText(''); setNoteScore(5)
  }

  // ── Cancel ────────────────────────────────────────────────────────
  const cancelWorkout = () => {
    clearDraft()
    updateSession(newSession())
    setIsWorkoutStarted(false)
    setShowCancelConfirm(false)
    setFinishMemo('')
    setRating(7)
    setUseCustomDateTime(false)
  }

  // ── Finish ────────────────────────────────────────────────────────
  const resetAfterFinish = () => {
    setShowSuccess(false)
    updateSession(newSession())
    setFinishMemo(''); setRating(7); setUseCustomDateTime(false)
    setIsWorkoutStarted(false); setPrs([])
  }

  const finishWorkout = () => {
    if (totalSets === 0) return
    const totalCal = sessionCalSummary.total
    const finished = {
      ...session,
      endTime: new Date().toTimeString().slice(0, 5),
      rating,
      memo: finishMemo,
      totalCalories: totalCal > 0 ? totalCal : undefined,
    }
    const newPRs   = computePRs(session, sessions)
    setFinishedSetCount(totalSets)
    onSaveSession(finished)
    clearDraft()
    setShowFinishModal(false)

    if (newPRs.length > 0) {
      setPrs(newPRs)
      setShowPRCelebration(true)
      setTimeout(() => {
        setShowPRCelebration(false)
        setShowSuccess(true)
        setTimeout(resetAfterFinish, 2200)
      }, 3200)
    } else {
      setShowSuccess(true)
      setTimeout(resetAfterFinish, 2500)
    }
  }

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* ── PR Celebration overlay ── */}
      {showPRCelebration && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg/95">
          {/* Floating confetti */}
          {['🎉','🎊','🏆','🌟','✨','🎉','🎊','🌟'].map((e, i) => (
            <span
              key={i}
              className="absolute text-3xl pointer-events-none"
              style={{
                left:      `${8 + i * 12}%`,
                bottom:    `${25 + (i % 3) * 8}%`,
                animation: `floatUp ${1.2 + i * 0.15}s ease-out ${i * 0.08}s forwards`,
              }}
            >{e}</span>
          ))}
          <div className="pop-in text-center px-6">
            <div className="text-6xl mb-4">🏆</div>
            <div className="text-2xl font-bold text-accent mb-2">記録更新！</div>
            <div className="space-y-2 mt-4">
              {prs.map((p, i) => (
                <div key={i} className="bg-card border border-accent/30 rounded-2xl px-4 py-3">
                  <div className="text-white font-bold text-sm">🎉 {p.name}</div>
                  <div className="text-accent text-sm mt-0.5">
                    平均負荷 {p.prevAvg} → <span className="font-bold text-lg">{p.newAvg}</span>
                    <span className="text-accentGreen ml-1">(+{p.newAvg - p.prevAvg})</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Success overlay ── */}
      {showSuccess && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg/95 slide-in">
          <div className="text-6xl mb-4">🎉</div>
          <div className="text-2xl font-bold text-accent mb-2">ワークアウト完了！</div>
          <div className="text-muted text-center px-8">
            お疲れ様でした！<br />{finishedSetCount}セットを記録しました。
          </div>
        </div>
      )}

      {/* ── Past-datetime warning ── */}
      {useCustomDateTime && (
        <div className="mx-4 mt-2 px-3 py-1.5 rounded-xl bg-yellow-500/10 border border-yellow-500/30 flex items-center gap-2 text-xs text-yellow-400">
          <span>⚠️</span>
          <span>過去の日時で記録中 — {customDate} {customTime}</span>
          <button onClick={() => setUseCustomDateTime(false)} className="ml-auto">✕</button>
        </div>
      )}

      {/* ── Workout-active banner ── */}
      {isWorkoutStarted && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-xl bg-accentGreen/10 border border-accentGreen/30 flex items-center gap-2">
          <span className="shimmer text-accentGreen text-sm">💪</span>
          <span className="text-accentGreen text-xs font-semibold">ワークアウト中</span>
          <span className="text-accentGreen text-xs font-mono ml-1">{formatElapsed(elapsedSeconds)}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-2">

        {/* ── Horizontal category scroll ── */}
        <div
          className="flex gap-2 overflow-x-auto px-4 pt-3 pb-1"
          style={{ scrollbarWidth: 'none' }}
        >
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => handleCategoryClick(cat)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap shrink-0 transition-all ${
                selectedCategory === cat && !isMemoMode
                  ? 'bg-accent text-bg font-bold shadow-md shadow-accent/30'
                  : 'bg-card text-muted border border-border'
              }`}
            >
              <span className="text-sm">{CATEGORY_ICONS[cat]}</span>
              <span>{cat}</span>
            </button>
          ))}
          {/* メモ button */}
          <button
            onClick={() => setIsMemoMode(true)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap shrink-0 transition-all ${
              isMemoMode
                ? 'bg-accentGreen text-bg font-bold shadow-md shadow-accentGreen/30'
                : 'bg-card text-muted border border-border'
            }`}
          >
            <span className="text-sm">📝</span>
            <span>メモ</span>
          </button>
        </div>

        {/* ── MEMO MODE ── */}
        {isMemoMode ? (
          <div className="px-4 mt-3">
            <div className="bg-card border border-border rounded-2xl p-4">
              <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">セッションメモを追加</div>
              <div className="mb-3">
                <label className="text-xs text-muted block mb-1">スコア</label>
                <select
                  value={noteScore}
                  onChange={e => setNoteScore(Number(e.target.value))}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-sm appearance-none"
                >
                  {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div className="mb-3">
                <label className="text-xs text-muted block mb-1">メモ</label>
                <textarea
                  value={noteText} onChange={e => setNoteText(e.target.value)}
                  placeholder="気づいたことや体調など..." rows={3}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-sm resize-none"
                />
              </div>
              <button
                onClick={addNote} disabled={!noteText.trim() || !isWorkoutStarted}
                className="w-full bg-accentGreen disabled:opacity-40 text-bg font-bold rounded-xl py-3 text-sm active:scale-95 transition-all"
              >
                ＋ メモを追加
              </button>
            </div>

            {(session.notes?.length ?? 0) > 0 && (
              <div className="mt-3">
                <div className="text-xs text-muted mb-2 font-medium uppercase tracking-wider">
                  今日のメモ ({session.notes!.length})
                </div>
                <div className="bg-card border border-border rounded-2xl divide-y divide-border">
                  {session.notes!.map((note, i) => (
                    <div key={i} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-accentGreen font-bold text-sm">スコア {note.score}</span>
                        <span className="text-xs text-muted">
                          {new Date(note.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="text-sm text-white">{note.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        ) : (
          /* ── EXERCISE MODE ── */
          <>
            {/* Exercise selector */}
            <div className="px-4 mt-2 flex gap-2">
              <select
                value={selectedExercise}
                onChange={e => handleExerciseChange(e.target.value)}
                className="flex-1 bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-white appearance-none"
              >
                {allExercisesSorted.map(ex => {
                  const count = usage[`${selectedCategory}/${ex}`] ?? 0
                  return (
                    <option key={ex} value={ex}>
                      {count > 0 ? `${ex} (${count})` : ex}
                    </option>
                  )
                })}
              </select>
              <button
                onClick={() => {
                  setCustomModalCat(selectedCategory)
                  setCustomModalType(selectedCategory === '有酸素' ? 'cardio' : 'strength')
                  setCustomName('')
                  setShowCustomModal(true)
                }}
                className="bg-card border border-border rounded-xl px-3 py-2.5 text-accent text-sm font-medium whitespace-nowrap"
              >
                ＋
              </button>
            </div>

            {/* Previous sets list */}
            {previousSets && (
              <div className="px-4 mt-1.5">
                <div className="text-[11px] text-muted/70 mb-0.5">
                  前回 ({previousSets.length}セット):
                </div>
                <div className="space-y-0.5 pl-1">
                  {previousSets.map((set, i) => (
                    <div key={i} className="text-xs text-muted">
                      {isCardio
                        ? `${set.durationMinutes ?? 0}分${set.distanceKm ? ` × ${set.distanceKm}km` : ''}`
                        : `${set.weight ?? 0}kg × ${set.reps ?? 0}回`}
                      {set.grip && <span className="text-muted/60"> ({set.grip})</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Set input card */}
            {!isWorkoutStarted ? (
              /* Not started: show prompt */
              <div className="px-4 mt-3">
                <div className="bg-card/50 border border-border border-dashed rounded-2xl p-6 flex flex-col items-center gap-2">
                  <span className="text-3xl">🏋️</span>
                  <span className="text-sm text-muted text-center">
                    下のボタンからワークアウトを開始するとセットを追加できます
                  </span>
                </div>
              </div>
            ) : (
              <div className="px-4 mt-2">
                <div className="bg-card border border-border rounded-2xl p-3">
                  {/* Header + datetime toggle */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs text-muted font-medium">
                      {editingSetId ? 'セットを編集' : `新しいセット — ${currentExerciseLabel}`}
                    </div>
                    <button
                      onClick={() => {
                        if (!showDatePicker) { setCustomDate(todayStr()); setCustomTime(nowTimeStr()) }
                        setShowDatePicker(v => !v)
                      }}
                      className={`text-xs px-2 py-1 rounded-lg border transition-all ${
                        useCustomDateTime
                          ? 'text-yellow-400 border-yellow-500/40 bg-yellow-500/10'
                          : 'text-muted border-border bg-surface/50'
                      }`}
                    >
                      🕐 日時
                    </button>
                  </div>

                  {/* Datetime picker */}
                  {showDatePicker && (
                    <div className="mb-2 p-2.5 bg-surface rounded-xl border border-border slide-in">
                      <div className="flex gap-2 mb-2">
                        <div className="flex-1">
                          <label className="text-xs text-muted block mb-1">日付</label>
                          <input type="date" value={customDate} max={todayStr()}
                            onChange={e => { setCustomDate(e.target.value); setUseCustomDateTime(true) }}
                            className="w-full bg-bg border border-border rounded-lg px-2 py-1.5 text-white text-xs" />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs text-muted block mb-1">時刻</label>
                          <input type="time" value={customTime}
                            onChange={e => { setCustomTime(e.target.value); setUseCustomDateTime(true) }}
                            className="w-full bg-bg border border-border rounded-lg px-2 py-1.5 text-white text-xs" />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => { setUseCustomDateTime(true); setShowDatePicker(false) }}
                          className="flex-1 bg-accent text-bg text-xs font-bold rounded-lg py-1.5">この日時で記録</button>
                        <button onClick={() => { setUseCustomDateTime(false); setShowDatePicker(false) }}
                          className="flex-1 bg-card text-muted text-xs border border-border rounded-lg py-1.5">現在時刻を使う</button>
                      </div>
                    </div>
                  )}

                  {/* Grip dropdown — ラットプルダウンのみ */}
                  {isLatPulldown && !isCardio && (
                    <div className="mb-2">
                      <label className="text-xs text-muted block mb-1">グリップ（任意）</label>
                      <select
                        value={gripInput}
                        onChange={e => setGripInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-sm appearance-none"
                      >
                        <option value="">-- 選択しない --</option>
                        {LAT_PULLDOWN_GRIPS.map(g => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </div>
                  )}

                  {isCardio ? (
                    <>
                      <div className="flex gap-2 mb-2">
                        <div className="flex-1">
                          <label className="text-xs text-muted block mb-1">時間 (分)</label>
                          <input type="number" inputMode="decimal" placeholder="30"
                            value={durationInput} onChange={e => setDurationInput(e.target.value)}
                            className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold" />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs text-muted block mb-1">距離 (km) 任意</label>
                          <input type="number" inputMode="decimal" placeholder="5.0"
                            value={distanceInput} onChange={e => setDistanceInput(e.target.value)}
                            className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold" />
                        </div>
                      </div>
                      {isWalking && (
                        <div className="mb-2">
                          <label className="text-xs text-muted block mb-1">傾斜 (%) — 0〜30</label>
                          <input type="number" inputMode="decimal" placeholder="0" min="0" max="30" step="0.5"
                            value={inclineInput} onChange={e => setInclineInput(e.target.value)}
                            className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold" />
                        </div>
                      )}
                      {estimatedCalories !== null && (
                        <div className="mb-2 px-3 py-2 bg-accentGreen/10 border border-accentGreen/30 rounded-xl flex items-center gap-2">
                          <span className="text-lg">🔥</span>
                          <span className="text-xs text-accentGreen font-bold">推定消費カロリー：{estimatedCalories} kcal</span>
                          <span className="text-xs text-muted ml-auto">休憩 {restSeconds}秒含む</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex gap-2 mb-2">
                        <div className="flex-1">
                          <label className="text-xs text-muted block mb-1">重量 (kg)</label>
                          <input type="number" inputMode="decimal" placeholder="60"
                            value={weightInput} onChange={e => setWeightInput(e.target.value)}
                            className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold" />
                        </div>
                        <div className="flex items-end pb-2.5 text-muted font-bold">×</div>
                        <div className="flex-1">
                          <label className="text-xs text-muted block mb-1">回数 (reps)</label>
                          <input type="number" inputMode="numeric" placeholder="10"
                            value={repsInput} onChange={e => setRepsInput(e.target.value)}
                            className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold" />
                        </div>
                      </div>
                      {estimatedCalories !== null && (
                        <div className="mb-2 px-3 py-1.5 bg-accentGreen/10 border border-accentGreen/30 rounded-xl flex items-center gap-2">
                          <span>🔥</span>
                          <span className="text-xs text-accentGreen font-bold">推定 {estimatedCalories} kcal</span>
                          <span className="text-xs text-muted ml-auto">休憩 {restSeconds}秒含む</span>
                        </div>
                      )}
                    </>
                  )}

                  <input type="text" placeholder="メモ（任意）"
                    value={setMemoInput} onChange={e => setSetMemoInput(e.target.value)}
                    className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-sm mb-2" />

                  <button
                    onClick={addOrUpdateSet}
                    disabled={isCardio ? !durationInput : !weightInput || !repsInput}
                    className="w-full bg-accent disabled:opacity-40 text-bg font-bold rounded-xl py-3 text-sm transition-all active:scale-95"
                  >
                    {editingSetId ? '✓ セットを更新' : '＋ セットを追加'}
                  </button>
                  {editingSetId && (
                    <button onClick={clearSetInputs} className="mt-1.5 w-full text-muted text-sm py-1.5">
                      キャンセル
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Sets list */}
            {currentSets.length > 0 && (
              <div className="px-4 mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs text-muted font-medium uppercase tracking-wider">
                    {currentExerciseLabel} — {currentSets.length}セット
                  </div>
                  {currentExerciseCalories > 0 && (
                    <div className="text-xs text-accentGreen font-bold">
                      🔥 合計 {currentExerciseCalories}kcal
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  {currentSets.map((set, idx) => (
                    <div key={set.id}>
                      <button
                        onClick={() => {
                          if (deleteConfirmId === set.id) { setDeleteConfirmId(null); return }
                          if (editingSetId === set.id) { clearSetInputs(); return }
                          startEditSet(set)
                        }}
                        className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all ${
                          editingSetId === set.id ? 'bg-accent/10 border-accent' : 'bg-card border-border'
                        }`}
                      >
                        <span className="text-muted text-sm shrink-0">セット {idx + 1}</span>
                        <div className="flex-1 text-right mr-2">
                          <span className="font-bold text-white">
                            {isCardio
                              ? [
                                  `${set.durationMinutes}分`,
                                  set.distanceKm ? `${set.distanceKm}km` : null,
                                  isWalking && set.incline ? `傾斜${set.incline}%` : null,
                                ].filter(Boolean).join(' · ')
                              : `${set.weight}kg × ${set.reps}回`}
                          </span>
                          {set.grip && <div className="text-xs text-muted/80 mt-0.5">{set.grip}</div>}
                          {set.calories != null && (
                            <div className="text-xs text-accentGreen mt-0.5">🔥 {set.calories}kcal</div>
                          )}
                          {set.memo && <div className="text-xs text-muted mt-0.5 truncate">{set.memo}</div>}
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); setDeleteConfirmId(set.id) }}
                          className="text-muted text-lg w-8 h-8 flex items-center justify-center shrink-0"
                        >×</button>
                      </button>
                      {deleteConfirmId === set.id && (
                        <div className="flex gap-2 mt-1 slide-in">
                          <button onClick={() => deleteSet(set.id)}
                            className="flex-1 bg-red-500/20 text-red-400 border border-red-500/30 rounded-xl py-2 text-sm font-medium">
                            削除する
                          </button>
                          <button onClick={() => setDeleteConfirmId(null)}
                            className="flex-1 bg-card text-muted border border-border rounded-xl py-2 text-sm">
                            キャンセル
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Today's summary */}
        {(session.exercises.length > 0 || (session.notes?.length ?? 0) > 0) && (
          <div className="px-4 mt-3">
            <div className="text-xs text-muted mb-1.5 font-medium uppercase tracking-wider">
              今日の記録 — {totalSets}セット
            </div>
            <div className="bg-card border border-border rounded-2xl divide-y divide-border">
              {session.exercises.map((ex, i) => {
                const exCal = ex.sets.reduce((sum, s) => sum + (s.calories ?? 0), 0)
                return (
                  <button
                    key={i}
                    onClick={() => {
                      setIsMemoMode(false)
                      setSelectedCategory(ex.category)
                      setSelectedExercise(ex.name)
                      setCurrentInstanceId((ex.instanceId ?? crypto.randomUUID()) as ReturnType<typeof crypto.randomUUID>)
                      clearSetInputs()
                    }}
                    className="w-full flex items-center justify-between px-4 py-3 text-left"
                  >
                    <div>
                      <div className="text-sm font-medium text-white">{getExerciseEntryLabel(session.exercises, ex)}</div>
                      <div className="text-xs text-muted">{ex.category}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-accent font-bold text-sm">{ex.sets.length}セット</div>
                      {exCal > 0 && <div className="text-xs text-accentGreen">🔥 {exCal}kcal</div>}
                    </div>
                  </button>
                )
              })}
              {(session.notes?.length ?? 0) > 0 && (
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="text-sm font-medium text-white">📝 メモ</div>
                  <div className="text-accentGreen font-bold text-sm">{session.notes!.length}件</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Footer button ── */}
      <div className="px-4 py-3 border-t border-border bg-bg">
        {isWorkoutStarted ? (
          <div className="flex gap-2">
            <button
              onClick={() => setShowCancelConfirm(true)}
              className="w-16 bg-red-500/15 border border-red-500/30 text-red-400 font-bold rounded-2xl py-4 text-sm transition-all active:scale-95 shrink-0"
            >
              🗑️
            </button>
            <button
              onClick={() => { if (totalSets > 0) setShowFinishModal(true) }}
              disabled={totalSets === 0}
              className="flex-1 bg-accentGreen/90 disabled:opacity-30 text-bg font-bold rounded-2xl py-4 text-base transition-all active:scale-95 shadow-lg shadow-accentGreen/20"
            >
              ワークアウトを終了する 💪
            </button>
          </div>
        ) : (
          <button
            onClick={startWorkout}
            className="w-full bg-accent text-bg font-bold rounded-2xl py-4 text-base transition-all active:scale-95 shadow-lg shadow-accent/30"
          >
            🏋️ ワークアウトを開始
          </button>
        )}
      </div>

      {/* ── Finish modal ── */}
      {showFinishModal && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowFinishModal(false)} />
          <div className="relative w-full bg-surface rounded-t-3xl px-4 pt-6 pb-8 slide-in max-h-[90vh] overflow-y-auto">
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-6" />
            <div className="text-lg font-bold text-white mb-4 text-center">ワークアウトを保存</div>

            {/* Calorie summary */}
            {sessionCalSummary.total > 0 && (
              <div className="mb-5 bg-accentGreen/10 border border-accentGreen/30 rounded-2xl p-4">
                <div className="text-xs text-accentGreen font-bold mb-2 uppercase tracking-wider">🔥 今回の推定消費カロリー</div>
                <div className="text-3xl font-bold text-white">
                  {sessionCalSummary.total}
                  <span className="text-base text-muted font-normal ml-1">kcal</span>
                </div>
                {sessionCalSummary.strength > 0 && sessionCalSummary.cardio > 0 && (
                  <div className="flex gap-4 text-xs text-muted mt-2">
                    <span>💪 筋トレ: {sessionCalSummary.strength}kcal</span>
                    <span>🏃 有酸素: {sessionCalSummary.cardio}kcal</span>
                  </div>
                )}
              </div>
            )}

            <div className="mb-6">
              <div className="text-sm text-muted mb-3 text-center">今日の評価</div>
              <div className="grid grid-cols-5 gap-2">
                {[1,2,3,4,5,6,7,8,9,10].map(n => (
                  <button key={n} onClick={() => setRating(n)}
                    className={`py-3 rounded-xl font-bold text-sm transition-all ${
                      rating === n ? 'bg-accent text-bg shadow-lg shadow-accent/30' : 'bg-card text-muted border border-border'
                    }`}
                  >{n}</button>
                ))}
              </div>
            </div>
            <div className="mb-6">
              <div className="text-sm text-muted mb-2">メモ (任意)</div>
              <textarea value={finishMemo} onChange={e => setFinishMemo(e.target.value)}
                placeholder="今日のワークアウトについて..." rows={3}
                className="w-full bg-card border border-border rounded-xl px-3 py-3 text-white text-sm resize-none" />
            </div>
            <button onClick={finishWorkout}
              className="w-full bg-accent text-bg font-bold rounded-2xl py-4 text-base active:scale-95 transition-all">
              保存する ✓
            </button>
          </div>
        </div>
      )}

      {/* ── Cancel confirm modal ── */}
      {showCancelConfirm && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCancelConfirm(false)} />
          <div className="relative w-full bg-surface rounded-t-3xl px-4 pt-6 pb-8 slide-in">
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-6" />
            <div className="text-lg font-bold text-white mb-2 text-center">⚠️ ワークアウトをキャンセル</div>
            <div className="text-sm text-muted text-center mb-6 leading-relaxed">
              現在の記録はすべて破棄されます。<br />この操作は取り消せません。
            </div>
            <div className="flex gap-2">
              <button
                onClick={cancelWorkout}
                className="flex-1 bg-red-500 text-white font-bold rounded-xl py-4 text-sm active:scale-95 transition-all"
              >
                破棄する
              </button>
              <button
                onClick={() => setShowCancelConfirm(false)}
                className="flex-1 bg-card text-muted border border-border rounded-xl py-4 text-sm"
              >
                続ける
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Custom exercise modal ── */}
      {showCustomModal && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCustomModal(false)} />
          <div className="relative w-full bg-surface rounded-t-3xl px-4 pt-6 pb-8 slide-in">
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-5" />
            <div className="text-lg font-bold text-white mb-5">カスタム種目を追加</div>

            {/* 種目名 */}
            <div className="mb-4">
              <label className="text-xs text-muted block mb-1.5">種目名</label>
              <input
                type="text"
                placeholder="例：ケーブルフライ"
                value={customName}
                onChange={e => setCustomName(e.target.value)}
                className="w-full bg-card border border-border rounded-xl px-3 py-3 text-white text-sm"
                autoFocus
              />
            </div>

            {/* カテゴリ選択 */}
            <div className="mb-4">
              <label className="text-xs text-muted block mb-1.5">大項目（カテゴリ）</label>
              <select
                value={customModalCat}
                onChange={e => {
                  const cat = e.target.value as Category
                  setCustomModalCat(cat)
                  if (cat === '有酸素') setCustomModalType('cardio')
                }}
                className="w-full bg-card border border-border rounded-xl px-3 py-3 text-white text-sm appearance-none"
              >
                {CATEGORIES.map(cat => (
                  <option key={cat} value={cat}>{CATEGORY_ICONS[cat]} {cat}</option>
                ))}
              </select>
            </div>

            {/* 種目タイプ */}
            <div className="mb-6">
              <label className="text-xs text-muted block mb-1.5">種目タイプ</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setCustomModalType('strength')}
                  className={`py-3 rounded-xl text-sm font-bold transition-all border ${
                    customModalType === 'strength'
                      ? 'bg-accent text-bg border-accent shadow-md shadow-accent/30'
                      : 'bg-card text-muted border-border'
                  }`}
                >
                  💪 筋トレ
                </button>
                <button
                  onClick={() => setCustomModalType('cardio')}
                  className={`py-3 rounded-xl text-sm font-bold transition-all border ${
                    customModalType === 'cardio'
                      ? 'bg-accentGreen text-bg border-accentGreen shadow-md shadow-accentGreen/30'
                      : 'bg-card text-muted border-border'
                  }`}
                >
                  🏃 有酸素
                </button>
              </div>
              <div className="text-xs text-muted mt-1.5">
                {customModalType === 'strength'
                  ? '重量・回数で記録。中程度METs（8.0）でカロリー計算'
                  : '時間・距離で記録。METs 5.0でカロリー計算'}
              </div>
            </div>

            <button
              onClick={() => {
                const name = customName.trim()
                if (!name) return
                onAddCustomExercise({
                  category:     customModalCat,
                  name,
                  exerciseType: customModalType,
                })
                // 追加したカテゴリに移動して選択状態にする
                if (customModalCat !== selectedCategory) {
                  setSelectedCategory(customModalCat)
                  setIsMemoMode(false)
                }
                setSelectedExercise(name)
                setCurrentInstanceId(crypto.randomUUID())
                clearSetInputs()
                setCustomName('')
                setShowCustomModal(false)
              }}
              disabled={!customName.trim()}
              className="w-full bg-accent disabled:opacity-40 text-bg font-bold rounded-2xl py-4 text-base active:scale-95 transition-all"
            >
              追加する
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-24 left-4 right-4 z-50 slide-in">
          <div className="bg-surface border border-accent/40 text-white px-4 py-3 rounded-2xl text-sm shadow-xl text-center">
            {toast}
          </div>
        </div>
      )}
    </div>
  )
}
