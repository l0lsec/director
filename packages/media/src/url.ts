/** URL for a local file served by the app's media:// protocol (range requests supported). */
export function mediaUrl(path: string): string {
  return `media://file${path.split('/').map(encodeURIComponent).join('/')}`;
}
