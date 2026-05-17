/**
 * calorieCalc.ts — 消費カロリー計算ユーティリティ
 *
 * 筋トレ：METs × 体重(kg) × 実施時間(h) × 1.05
 *   時間 = (回数 × 4秒) + レスト秒数
 *   ※METs値は EPOC・熱損失・心拍上昇・回復コストを含む実効値
 *
 * 有酸素：種目ごとの精度の高い計算式を使用
 *
 * 期待値（体重63kg・10回・休憩90秒）
 *   複合種目：28〜30 kcal/set
 *   中程度種目：19〜21 kcal/set
 *   体幹種目：12〜14 kcal/set
 */

import type { Category } from '../types'

// ── 筋トレ：複合・高負荷種目（実効METs 12.0）────────────────────────────────
// スクワット・デッドリフト・ベンチプレス・ラットプルダウン・ローイング系など
// 複数の大筋群を動員し、EPOC・熱損失が大きい種目
const COMPOUND_EXERCISES = new Set([
  // 胸
  'ベンチプレス', 'インクラインプレス', 'インクラインベンチプレス', 'インクラインダンベルプレス',
  'ダンベルプレス', 'ワイドダンベルプレス', 'チェストプレス', 'ディップス', 'ナローグリップベンチプレス',
  // 背中
  'デッドリフト', 'ラットプルダウン', 'チンニング（懸垂）', 'ベントオーバーロー', 'シーテッドロウ',
  'ケーブルプルオーバー', 'ハイロー', 'Tバーロウ', 'ストレートプルオーバー', 'ワンハンドローイング',
  'ローロウ', 'ロー/リアデルトイド', 'バックエクステンション', 'シュラッグ',
  // 肩（プレス系）
  'ショルダープレス', 'ダンベルショルダープレス', 'アーノルドプレス', 'アップライトロウ', 'ケーブルフェイスプル',
  // 脚
  'スクワット', 'スミスマシン・バーベルスクワット', 'レッグプレス', 'シーテッドレッグプレス',
  'ブルガリアンスクワット', 'ルーマニアンデッドリフト', 'ランジ', 'レッグカール', 'シーテッドレッグカール',
  'レッグエクステンション', 'レッグアブダクション',
  // お尻
  'ヒップスラスト', 'グルートブリッジ', 'スモウスクワット',
])

// ── 筋トレ：体幹・腹筋種目（実効METs 5.0）────────────────────────────────
// 自重中心で負荷は中〜低、EPOC は小さめ
const CORE_EXERCISES = new Set([
  'プランク', 'クランチ', 'シットアップ', 'レッグレイズ', 'ハンギングレッグレイズ',
  'ロシアンツイスト', 'アブローラー', 'ケーブルクランチ', 'バイシクルクランチ',
])

// 実効METs定数
const METS_COMPOUND = 12.0  // 複合・高負荷（EPOC・熱損失を含む実効値）
const METS_MEDIUM   = 8.0   // 中程度（レイズ・フライ・カール・ケーブル系）
const METS_CORE     = 5.0   // 体幹・腹筋系

/** 筋トレ種目の 実効METs 値を返す。 */
export function getStrengthMETs(name: string, _category?: Category): number {
  if (CORE_EXERCISES.has(name)) return METS_CORE
  if (COMPOUND_EXERCISES.has(name)) return METS_COMPOUND
  return METS_MEDIUM
}

/**
 * 筋トレ 1 セットの推定消費カロリー (kcal)
 *
 * 実施時間 = reps × 4秒（TUT）+ restSeconds（休憩）
 * kcal = 実効METs × bodyWeight(kg) × 実施時間(h) × 1.05
 *
 * 例）複合・10回・休憩90秒・体重63kg
 *   time = 10×4+90 = 130s = 0.0361h
 *   12.0 × 63 × 0.0361 × 1.05 ≈ 28.7 kcal
 */
export function calcStrengthSetCalories(
  name: string,
  category: Category | undefined,
  reps: number,
  restSeconds: number,
  bodyWeight: number,
): number {
  if (reps <= 0 || bodyWeight <= 0) return 0
  const mets    = getStrengthMETs(name, category)
  const seconds = reps * 4 + restSeconds   // 4秒/rep（TUT + 降ろし含む）
  return Math.max(1, Math.round(mets * bodyWeight * (seconds / 3600) * 1.05))
}

// ── 有酸素：種目別 METs ───────────────────────────────────────────────────
const CARDIO_METS_MAP: Record<string, number> = {
  'ランニング':       9.8,
  'ウォーキング':     3.5,
  'サイクリング':     7.5,
  '縄跳び':          11.8,
  '水泳':            7.0,
  'エリプティカル':   5.0,
  'ローイングマシン': 8.5,
  'HIIT':            12.0,
  'ステアクライマー': 9.0,
}

/**
 * 有酸素 1 セットの推定消費カロリー (kcal)
 *
 * ランニング:   距離あり → 体重 × km × 1.04、なし → METs 9.8 × 体重 × 時間 × 1.05
 * ウォーキング: 距離あり → 体重 × km × (0.5 + 傾斜% × 0.01)、なし → METs法
 * HIIT:         12.0 × 体重 × 時間 × 1.15（アフターバーン込み）
 * その他:        METs × 体重 × 時間 × 1.05
 */
export function calcCardioSetCalories(
  name: string,
  durationMinutes: number,
  distanceKm?: number,
  incline?: number,
  bodyWeight?: number,
): number {
  const bw   = bodyWeight ?? 63
  if (bw <= 0 || durationMinutes <= 0) return 0
  const hours = durationMinutes / 60
  const dist  = distanceKm && distanceKm > 0 ? distanceKm : null
  const inc   = incline ?? 0

  if (name === 'ランニング') {
    if (dist) return Math.round(bw * dist * 1.04)
    return Math.round(9.8 * bw * hours * 1.05)
  }

  if (name === 'ウォーキング') {
    if (dist) return Math.round(bw * dist * (0.5 + inc * 0.01))
    const mets = 3.5 + inc * 0.2
    return Math.round(mets * bw * hours * 1.05)
  }

  if (name === 'HIIT') return Math.round(12.0 * bw * hours * 1.15)

  const mets = CARDIO_METS_MAP[name] ?? 5.0
  return Math.round(mets * bw * hours * 1.05)
}

/**
 * セッション全体の消費カロリーを常に新しい計算式で算出する。
 * 保存済みの set.calories は参照せず、生データ（reps・duration 等）から再計算。
 * これにより、METs式変更後も過去データが正しく表示される。
 */
export function getSessionCaloriesData(
  session: import('../types').WorkoutSession,
  bodyWeight: number,
  defaultRestSeconds = 90,
): { strength: number; cardio: number; total: number } {
  let strength = 0, cardio = 0

  for (const ex of session.exercises) {
    for (const set of ex.sets) {
      let cal = 0
      if (ex.category === '有酸素' && set.durationMinutes) {
        cal = calcCardioSetCalories(ex.name, set.durationMinutes, set.distanceKm, set.incline, bodyWeight)
      } else if (ex.category !== '有酸素' && set.reps) {
        cal = calcStrengthSetCalories(ex.name, ex.category, set.reps, defaultRestSeconds, bodyWeight)
      }
      if (ex.category === '有酸素') cardio += cal
      else strength += cal
    }
  }

  return { strength: Math.round(strength), cardio: Math.round(cardio), total: Math.round(strength + cardio) }
}

/**
 * 全セッションのカロリーデータを新しい計算式で遡及計算する。
 * 各セットの calories フィールドを更新し、session.totalCalories も再計算する。
 * 変更があった場合のみ updated セッションを返す（不変）。
 */
export function migrateSessionCalories(
  sessions: import('../types').WorkoutSession[],
  bodyWeight: number,
  restSeconds: number,
): import('../types').WorkoutSession[] {
  return sessions.map(session => {
    const newExercises = session.exercises.map(ex => ({
      ...ex,
      sets: ex.sets.map(set => {
        let newCal: number | undefined
        if (ex.category === '有酸素' && set.durationMinutes) {
          newCal = calcCardioSetCalories(
            ex.name, set.durationMinutes, set.distanceKm, set.incline, bodyWeight,
          )
        } else if (ex.category !== '有酸素' && set.reps) {
          newCal = calcStrengthSetCalories(
            ex.name, ex.category, set.reps, restSeconds, bodyWeight,
          )
        }
        if (newCal === undefined || newCal === set.calories) return set
        return { ...set, calories: newCal }
      }),
    }))

    const totalCal = newExercises.reduce(
      (s, ex) => s + ex.sets.reduce((s2, set) => s2 + (set.calories ?? 0), 0), 0,
    )

    return {
      ...session,
      exercises:      newExercises,
      totalCalories:  totalCal > 0 ? totalCal : undefined,
    }
  })
}
