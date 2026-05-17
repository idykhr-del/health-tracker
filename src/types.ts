export type Category =
  | '胸'
  | '背中'
  | '腕'
  | '肩'
  | '脚'
  | '腹筋'
  | 'お尻'
  | '有酸素'

export interface WorkoutSet {
  id: string
  weight?: number
  reps?: number
  durationMinutes?: number
  distanceKm?: number
  incline?: number     // ウォーキング傾斜 (%)
  calories?: number    // 推定消費カロリー (kcal)
  grip?: string        // ラットプルダウン グリップ種類
  timestamp: string
  memo?: string
}

export interface ExerciseEntry {
  category: Category
  name: string
  instanceId?: string
  sets: WorkoutSet[]
}

export interface SessionNote {
  score: number
  text: string
  timestamp: string
}

export interface WorkoutSession {
  id: string
  date: string
  startTime: string
  endTime?: string
  rating?: number
  memo?: string
  exercises: ExerciseEntry[]
  notes?: SessionNote[]
  totalCalories?: number   // セッション全体の推定消費カロリー (kcal)
}

export interface CustomExercise {
  category: Category
  name: string
  exerciseType?: 'strength' | 'cardio'  // 未設定の場合は筋トレ扱い
}

export interface WorkoutData {
  sessions: WorkoutSession[]
  customExercises: CustomExercise[]
}
