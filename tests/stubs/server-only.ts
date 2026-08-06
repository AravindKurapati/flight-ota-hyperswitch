// Stub for the `server-only` package under Vitest.
// The real package throws when imported outside a React Server Component
// context, which vitest is not. Tests alias `server-only` to this no-op
// so that modules starting with `import 'server-only'` remain importable.
export {};
