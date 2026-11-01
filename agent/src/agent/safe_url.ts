// Addresses a page gave (a list item's link, a source) as Ditto's own pages
// may show them: only ones that open a page or show a picture, never
// javascript:, file: or data: documents.
export function safeUrl(attribute: 'href'|'src', url: string): boolean {
  const value = url.trim();
  if (/^(https?:|ditto:|#)/i.test(value)) {
    return true;
  }
  return attribute === 'href' ? /^mailto:/i.test(value) :
      /^data:image\/(png|jpe?g|gif|webp);/i.test(value);
}
