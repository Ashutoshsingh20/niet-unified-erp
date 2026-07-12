export function safeReturnTo(candidate: string | null): string {
  return candidate !== null && candidate.startsWith('/') && !candidate.startsWith('//')
    ? candidate : '/';
}
