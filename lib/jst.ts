/**
 * JST（UTC+9）基準の日付ユーティリティ。
 *
 * このアプリの日付キー（Withings / AutoSleep / Notion のレコード）は
 * すべて JST の YYYY-MM-DD。サーバー（Vercel = UTC）とブラウザの
 * どちらで評価しても同じ日付になるよう、必ずこのモジュールを通す。
 *
 * 注意: `new Date().toISOString().slice(0, 10)` は UTC 日付なので、
 * JST 00:00〜09:00 の間だけ1日前になる。直接書かないこと。
 *
 * import の書き方（構成の都合で拡張子が異なる）:
 *   api/  … import { jstDateKey } from '../lib/jst.js'      (Node ESM)
 *   src/  … import { jstDateKey } from '../../lib/jst'      (bundler)
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * 時刻を JST に直した ISO 文字列。
 * 末尾は `Z` だが中身は JST の壁時計なので、slice して日付・時刻を取り出す用途に限る。
 *   例: jstIsoString(d).slice(0, 10) → YYYY-MM-DD / .slice(11, 16) → HH:MM
 */
export function jstIsoString(d: Date = new Date()): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString()
}

/** 時刻を JST に直して YYYY-MM-DD を返す（引数なしなら JST の「今日」） */
export function jstDateKey(d: Date = new Date()): string {
  return jstIsoString(d).slice(0, 10)
}
