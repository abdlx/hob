export type LibraryKind = 'all' | 'images' | 'documents' | 'spreadsheets' | 'code' | 'other';
export interface LibraryEntry { name: string; path: string; directory: boolean; size?: number }
export interface LibraryPreview { name: string; dataUrl: string; mimeType: string; size: number }

export function libraryKind(name: string): Exclude<LibraryKind, 'all'> {
  const extension = name.split('.').at(-1)?.toLowerCase() || '';
  if (/^(png|jpe?g|webp|gif|avif|bmp)$/.test(extension)) return 'images';
  if (/^(csv|tsv|xlsx?|ods)$/.test(extension)) return 'spreadsheets';
  if (/^(pdf|docx?|odt|txt|md|markdown|rtf|pptx?|odp)$/.test(extension)) return 'documents';
  if (/^(js|jsx|ts|tsx|mjs|cjs|json|py|html?|css|scss|sh|sql|ya?ml|xml|toml|rs|go|java|c|cpp|h|rb|svg)$/.test(extension)) return 'code';
  return 'other';
}

export function librarySize(bytes?: number): string {
  if (bytes === undefined) return 'File';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function libraryText(file: LibraryPreview): string | null {
  if (!file.mimeType.startsWith('text/') && !/\.(?:md|markdown|txt|csv|tsv|json|js|jsx|ts|tsx|mjs|cjs|py|html?|css|scss|sh|sql|ya?ml|xml|toml|rs|go|java|c|cpp|h|rb|svg)$/i.test(file.name)) return null;
  try {
    const encoded = file.dataUrl.slice(file.dataUrl.indexOf(',') + 1);
    return /;base64,/i.test(file.dataUrl)
      ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded), letter => letter.charCodeAt(0)))
      : decodeURIComponent(encoded);
  } catch { return null; }
}
