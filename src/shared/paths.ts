/** The last part of a path as messages show it, whichever separator the system uses. */
export function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}
