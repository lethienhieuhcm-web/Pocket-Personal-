// Test-only stub: stock.js imports drizzle-orm for D1 user tables, which the
// flow-screen handlers never touch. No node_modules in this worktree.
export function drizzle(){ return {}; }
export function eq(...a){ return a; }
export function and(...a){ return a; }
export function asc(...a){ return a; }
export function sql(...a){ return a; }
export function gt(...a){ return a; }
export function ne(...a){ return a; }
export function desc(...a){ return a; }
export function lt(...a){ return a; }
